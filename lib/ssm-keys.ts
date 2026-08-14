// lib/ssm-keys.ts
//
// The single source of truth for the SHAPE of the SSM tree: every relative key
// published under /{project}/{env}/, mapped to the value it carries.
//
// Three consumers read this one map, which is the point — none of them holds a
// second copy of the list that could drift:
//   - lib/stacks/ssm-parameters-stack.ts  publishes it
//   - test/ssm-publishing.test.ts         asserts the synth matches it
//   - scripts/integration_test.sh         asserts the LIVE tree contains it
//
// Deliberately a presence contract, not a count: a fork that adds a key here
// stays green everywhere without editing a hardcoded total in three places.
//
// Key strings are also logical-ID inputs in the stack (`P-<key with / → ->`),
// so RENAMING a key replaces the deployed parameter. Add freely; rename with
// the same care as any other resource rename.
import { InputConfig } from './config';
import { DerivedNames } from './names';

/**
 * Published by the EC2 stack rather than the SSM stack: its value is a runtime
 * token of a replaceable instance, and importing it into the SSM stack would
 * create a cross-stack export that blocks instance replacement. It is still
 * part of the tree every consumer expects, so it is named here.
 */
export const EC2_INSTANCE_ID_KEY = 'ec2/instanceId';

/** Every parameter the SSM stack publishes, in publication order. */
export function ssmParameters(config: InputConfig, names: DerivedNames): Record<string, string> {
    return {
        // meta
        'meta/projectId': names.meta.projectId,
        'meta/region': names.meta.region,
        'meta/accountId': names.meta.accountId,
        'meta/toolkitVersion': names.meta.toolkitVersion,

        // buckets
        'buckets/metadata': names.buckets.metadata,
        'buckets/bronze': names.buckets.bronze,
        'buckets/silver': names.buckets.silver,
        'buckets/gold': names.buckets.gold,
        'buckets/athenaResults': names.buckets.athenaResults,
        'buckets/validation': names.buckets.validation,
        'buckets/artifact': names.buckets.artifact,

        // glue databases
        'glue/db/metadata': names.glueDatabases.metadata,
        'glue/db/bronze': names.glueDatabases.bronze,
        'glue/db/silver': names.glueDatabases.silver,
        'glue/db/gold': names.glueDatabases.gold,
        'glue/db/validation': names.glueDatabases.validation,
        'glue/db/ciSilver': names.glueDatabases.ciSilver,
        'glue/db/ciGold': names.glueDatabases.ciGold,

        // athena
        'athena/workgroup': names.athena.workgroup,
        'athena/outputLocation': names.athena.outputLocation,

        // release ledger (lives in the metadata DB)
        'release/db': names.release.db,
        'release/table': names.release.table,

        // roles
        'roles/glueEtl': names.roles.glueEtl,

        // codebuild / codepipeline
        'codebuild/dbtTestAndRun': names.codebuild.dbtTestAndRun,
        'codebuild/dbtReleaseBuilder': names.codebuild.dbtReleaseBuilder,
        'codepipeline/dbtTestAndRun': names.codepipeline.dbtTestAndRun,
        'codepipeline/writeReleaseInfo': names.codepipeline.writeReleaseInfo,

        // step functions
        'stepfunctions/validation': names.stepFunctions.validation,
        'stepfunctions/validationCi': names.stepFunctions.validationCi,
        'stepfunctions/writeReleaseJsons': names.stepFunctions.writeReleaseJsons,

        // ec2 (instanceId is published by the EC2 stack — see EC2_INSTANCE_ID_KEY)
        'ec2/logGroup': names.ec2.logGroup,
        'ec2/logBucket': names.ec2.logBucket,
        'ec2/logPrefix': names.ec2.logPrefix,

        // app facts (INPUTS mirrored for the CLI — snake_case per the toolkit's
        // resolver contract; secret NAMES only, values stay in Secrets Manager)
        'app/dictionary_version': config.gen3.dictionaryVersion,
        'app/aws_secret_name': config.gen3.awsSecretName,
        'app/schema_s3_uri': config.gen3.schemaS3Uri,
        'app/domain': config.gen3.domain,
        'app/app_name': config.gen3.appName,
        'app/namespace': config.gen3.namespace,
        'app/cluster_name': config.gen3.clusterName,
        'app/schema_repo': config.gen3.schemaRepo,
    };
}

/**
 * Every key expected in a deployed tree: what the SSM stack publishes, plus the
 * one the EC2 stack adds. This is what integration_test.sh probes for.
 */
export function expectedTreeKeys(config: InputConfig, names: DerivedNames): string[] {
    return [...Object.keys(ssmParameters(config, names)), EC2_INSTANCE_ID_KEY];
}
