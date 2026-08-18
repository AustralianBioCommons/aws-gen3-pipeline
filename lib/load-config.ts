// lib/load-config.ts
// Resolves the INPUTS-only config, in precedence order:
//   1. -c env=<name> [-c project=<id>] -> reads config/<projectId>.<name>.json
//      (operator workflow; `project` is only needed when the config dir holds
//      more than one project for that env)
//   2. -c pipelineConfig=<json>        -> inline JSON via CDK context
//   3. PIPELINE_CONFIG_JSON            -> env var (how CI / the future project
//                                         repo hands the CDK a config file it owns)
//
// The filename convention is <projectId>.<env>.json — the project id is NOT
// hard-coded here; the file is found by its ".<env>.json" suffix (qualified by
// the project id when given) and then cross-checked against the
// projectId/environment fields inside it.
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { InputConfig } from './config';

/**
 * Locate config/<projectId>.<env>.json. Without a projectId, exactly one file
 * may match the env suffix; with one, that project's file must exist.
 */
export function findConfigFile(envName: string, projectId?: string, configDir?: string): string {
    const dir = configDir ?? path.join(process.cwd(), 'config');
    const suffix = `.${envName}.json`;

    if (projectId) {
        const file = path.join(dir, `${projectId}${suffix}`);
        if (!fs.existsSync(file)) {
            throw new Error(
                `No config file for project "${projectId}" env "${envName}" — expected config/${projectId}${suffix}`,
            );
        }
        return file;
    }

    const matches = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith(suffix))
        : [];
    if (matches.length === 0) {
        throw new Error(
            `No config file for env "${envName}" — expected config/<projectId>${suffix}`,
        );
    }
    if (matches.length > 1) {
        throw new Error(
            `Multiple config files for env "${envName}" (${matches.join(', ')}) - ` +
            `disambiguate with -c project=<projectId>`,
        );
    }
    return path.join(dir, matches[0]);
}

export function loadConfig(app: cdk.App): InputConfig {
    const envName = app.node.tryGetContext('env');
    if (envName) {
        const file = findConfigFile(envName, app.node.tryGetContext('project'));
        const cfg = validate(JSON.parse(fs.readFileSync(file, 'utf-8')));
        // The filename encodes projectId + env; disagreement with the file's
        // contents deploys under unexpected names — fail loudly instead.
        const expected = `${cfg.projectId}.${cfg.environment}.json`;
        if (path.basename(file) !== expected) {
            throw new Error(
                `Config file ${path.basename(file)} does not match its contents ` +
                `(projectId "${cfg.projectId}", environment "${cfg.environment}") — rename it to ${expected}`,
            );
        }
        return cfg;
    }

    const ctx = app.node.tryGetContext('pipelineConfig');
    const envJson = process.env.PIPELINE_CONFIG_JSON;
    const raw = ctx ?? envJson;
    if (!raw) {
        throw new Error(
            'No config provided. Pass -c env=<test|staging|prod> (reads config/<projectId>.<env>.json), ' +
            'or set CDK context "pipelineConfig" / env PIPELINE_CONFIG_JSON.',
        );
    }
    return validate(typeof raw === 'string' ? JSON.parse(raw) : raw);
}

function validate(parsed: unknown): InputConfig {
    const cfg = parsed as InputConfig;
    const missing = (['projectId', 'environment', 'accountId', 'region',
        'repo', 'ec2', 'toolkitVersion', 'gen3'] as const)
        .filter((k) => !cfg[k]);
    if (missing.length) {
        throw new Error(`Config is missing required INPUT field(s): ${missing.join(', ')}`);
    }
    // Every gen3.* fact is mirrored to SSM for the toolkit; a missing one
    // would publish "undefined" and only surface deep inside a job run.
    const missingGen3 = (['dictionaryVersion', 'dictionaryBaseUrl', 'dictionaryPath',
        'awsSecretName', 'schemaS3Uri', 'domain', 'appName', 'namespace',
        'clusterName', 'schemaRepo'] as const)
        .filter((k) => !cfg.gen3[k]);
    if (missingGen3.length) {
        throw new Error(
            `Config is missing required gen3.* field(s): ${missingGen3.join(', ')}`);
    }
    validateCustomJobs(cfg);
    return cfg;
}

// Custom jobs are the one config block authored by deployment wrappers rather
// than this repo, so bad values arrive from outside — reject them here with
// the offending key named, not deep inside a stack synth.
function validateCustomJobs(cfg: InputConfig): void {
    const seen = new Set<string>();
    for (const job of cfg.customJobs ?? []) {
        if (!/^[a-z][A-Za-z0-9]*$/.test(job.key ?? '')) {
            throw new Error(
                `customJobs entry has invalid key "${job.key}" — use a camelCase slug (e.g. "myIngestJob")`,
            );
        }
        // Bare filename only: scriptLocation is derived as
        // s3://<metadata-bucket>/scripts/<scriptFile>, so a path separator
        // would escape the scripts/ prefix.
        if (!/^[A-Za-z0-9_-]+\.py$/.test(job.scriptFile ?? '')) {
            throw new Error(
                `customJobs "${job.key}" has invalid scriptFile "${job.scriptFile}" — ` +
                'expected a bare .py filename in glue-scripts/ (no path separators)',
            );
        }
        if (seen.has(job.key)) {
            throw new Error(`customJobs has duplicate key "${job.key}"`);
        }
        seen.add(job.key);
    }
}
