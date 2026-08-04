// lib/names.ts
//
// The single source of truth for every OUTPUT name the pipeline creates.
// Pure function — no AWS calls, no CDK constructs — so the same strings are
// used by every stack, published to SSM, and trivially unit-testable
// (see test/names.test.ts).
//
// Conventions (do not drift):
//   S3 buckets      <project>-<env>-<suffix>-<account>-<region>   (lower-case)
//   Glue databases  <project>_<env>_<suffix>_db                   (underscores)
//   everything else <project>-<env>-<suffix>                      (dashes)
import { InputConfig } from './config';

export interface GlueJobDerived {
    /** Stable slug used in code (e.g. Step Functions lookups) — never shown to AWS. */
    key: string;
    /** Deployed Glue job name (env-prefixed so test/prod jobs cannot collide). */
    name: string;
    /** s3://<metadata-bucket>/scripts/<file>.py */
    scriptLocation: string;
    // Per-job overrides, present only on custom (config-declared) jobs.
    // Built-in jobs use the stack defaults.
    extraPythonModules?: string[];
    extraArgs?: Record<string, string>;
    maxCapacity?: number;
    timeoutMinutes?: number;
}

export interface DerivedNames {
    meta: { projectId: string; region: string; accountId: string; toolkitVersion: string };
    buckets: {
        metadata: string; rawBronze: string; rawSilver: string; rawGold: string;
        athenaResults: string; validation: string; artifact: string;
    };
    glueDatabases: {
        metadata: string; rawBronze: string; rawSilver: string; rawGold: string; validation: string;
        // CI isolation: the dbt template's `ci` target builds into these,
        // keeping commit-triggered CI off the real warehouse databases.
        ciRawSilver: string; ciRawGold: string;
    };
    athena: { workgroup: string; outputLocation: string };
    release: { db: string; table: string };
    roles: { glueEtl: string };
    codebuild: { dbtTestAndRun: string; dbtReleaseBuilder: string };
    codepipeline: { dbtTestAndRun: string; writeReleaseInfo: string };
    stepFunctions: { validation: string; writeReleaseJsons: string };
    glueJobs: GlueJobDerived[];
    ec2: { logGroup: string; logBucket: string; logPrefix: string };
}

const RELEASE_TABLE = 'releases';

/** camelCase → kebab-case ("ingestMetadataTemplates" → "ingest-metadata-templates"). */
const kebab = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

function deriveGlueJobs(
    cfg: InputConfig,
    prefix: string,
    script: (file: string) => string,
): GlueJobDerived[] {
    // The three Step Functions-orchestrated jobs plus the manual-invoke ingest
    // job ship with the pipeline; their keys are a cross-stack contract
    // (stepfunctions-stack looks them up and throws if missing).
    const builtIns: GlueJobDerived[] = [
        { key: 'writeValidationJsons', name: `${prefix}-write-validation-jsons`, scriptLocation: script('write_validation_jsons.py') },
        { key: 'silverJsonGen3Validator', name: `${prefix}-silver-json-gen3-validator`, scriptLocation: script('silver_json_gen3_validator.py') },
        { key: 'writeDataReleaseToJson', name: `${prefix}-write-data-release-to-json`, scriptLocation: script('write_data_release_to_json.py') },
        { key: 'ingestMetadataTemplates', name: `${prefix}-ingest-metadata-templates`, scriptLocation: script('ingest_metadata_templates.py') },
    ];

    const jobs = [...builtIns];
    for (const custom of cfg.customJobs ?? []) {
        if (jobs.some((j) => j.key === custom.key)) {
            throw new Error(
                `customJobs key "${custom.key}" collides with an existing Glue job — ` +
                `taken keys: ${jobs.map((j) => j.key).join(', ')}`,
            );
        }
        jobs.push({
            key: custom.key,
            name: `${prefix}-${custom.nameSuffix ?? kebab(custom.key)}`,
            scriptLocation: script(custom.scriptFile),
            extraPythonModules: custom.extraPythonModules,
            extraArgs: custom.extraArgs,
            maxCapacity: custom.maxCapacity,
            timeoutMinutes: custom.timeoutMinutes,
        });
    }
    return jobs;
}

export function deriveNames(cfg: InputConfig): DerivedNames {
    const { projectId, environment, accountId, region, toolkitVersion } = cfg;

    const prefix = `${projectId}-${environment}`;   // dashes: buckets, roles, workgroup, pipelines
    const dbPrefix = `${projectId}_${environment}`; // underscores: Glue databases

    const bucket = (suffix: string) =>
        `${prefix}-${suffix}-${accountId}-${region}`.toLowerCase();

    const buckets = {
        metadata: bucket('metadata'),
        rawBronze: bucket('raw-bronze'),
        rawSilver: bucket('raw-silver'),
        rawGold: bucket('raw-gold'),
        // 'athena-results', not 'aws-athena-query-results': S3 caps bucket
        // names at 63 chars and the long form overflows for env "staging".
        athenaResults: bucket('athena-results'),
        validation: bucket('validation'),
        artifact: bucket('artifact'),
    };

    const glueDatabases = {
        metadata: `${dbPrefix}_dataops_metadata_db`,
        rawBronze: `${dbPrefix}_raw_bronze_db`,
        rawSilver: `${dbPrefix}_raw_silver_db`,
        rawGold: `${dbPrefix}_raw_gold_db`,
        validation: `${dbPrefix}_validation_db`,
        // CI isolation: ONLY the dbt template's `ci` target maps to these
        // (leading ci_ prefix on the otherwise-unchanged real name). The
        // real databases above are never prefixed, and the toolkit's
        // find_db_for_model skips ci_* so releases can't pin CI snapshots.
        ciRawSilver: `ci_${dbPrefix}_raw_silver_db`,
        ciRawGold: `ci_${dbPrefix}_raw_gold_db`,
    };

    const script = (file: string) => `s3://${buckets.metadata}/scripts/${file}`;

    return {
        meta: { projectId, region, accountId, toolkitVersion },
        buckets,
        glueDatabases,
        athena: {
            workgroup: prefix,
            outputLocation: `s3://${buckets.athenaResults}/`,
        },
        release: { db: glueDatabases.metadata, table: RELEASE_TABLE },
        roles: { glueEtl: `${prefix}-glue-etl-role` },
        codebuild: {
            dbtTestAndRun: `${prefix}-dbt-test-and-run`,
            dbtReleaseBuilder: `${prefix}-dbt-release-builder`,
        },
        codepipeline: {
            dbtTestAndRun: `${prefix}-dbt-test-and-run`,
            writeReleaseInfo: `${prefix}-dbt-write-release-info`,
        },
        stepFunctions: {
            validation: `${prefix}-validation`,
            writeReleaseJsons: `${prefix}-write-release-jsons`,
        },
        glueJobs: deriveGlueJobs(cfg, prefix, script),
        ec2: {
            // The value Doc 07's dispatch tails with `g3dt jobs logs --follow`.
            logGroup: `/${projectId}/${environment}/ec2/jobs`,
            logBucket: buckets.metadata,
            logPrefix: 'ec2-job-logs',
        },
    };
}
