// lib/stacks/ssm-parameters-stack.ts
//
// Publishes every OUTPUT name (plus the app INPUT facts) to SSM Parameter
// Store under /{project}/{env}/... — the runtime source of truth read by the
// g3dt CLI, CodeBuild, the EC2 job box and Glue. Deployed LAST (build-app.ts
// adds a dependency on every other stack) so a name is never published before
// its resource exists.
//
// 40 parameters per env: 32 OUTPUT names + 8 app/* facts. (The 41st tree
// entry, ec2/instanceId, is published by the EC2 stack itself — its value is
// a runtime token of a replaceable instance, and importing it here would
// create a cross-stack export that blocks instance replacement.)
// test/ssm-publishing.test.ts is the drift guard: add a named resource
// without a put() here and the suite goes red.
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { InputConfig } from '../config';
import { DerivedNames } from '../names';

export interface SsmParametersStackProps extends cdk.StackProps {
    config: InputConfig;
    names: DerivedNames;
}

export class SsmParametersStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: SsmParametersStackProps) {
        super(scope, id, props);

        const { config, names } = props;
        const base = `/${config.projectId}/${config.environment}`;

        const put = (rel: string, value: string) =>
            new ssm.StringParameter(this, `P-${rel.replace(/\//g, '-')}`, {
                parameterName: `${base}/${rel}`,
                stringValue: value,
            });

        // meta
        put('meta/projectId', names.meta.projectId);
        put('meta/region', names.meta.region);
        put('meta/accountId', names.meta.accountId);
        put('meta/toolkitVersion', names.meta.toolkitVersion);

        // buckets
        put('buckets/metadata', names.buckets.metadata);
        put('buckets/bronze', names.buckets.bronze);
        put('buckets/silver', names.buckets.silver);
        put('buckets/gold', names.buckets.gold);
        put('buckets/athenaResults', names.buckets.athenaResults);
        put('buckets/validation', names.buckets.validation);
        put('buckets/artifact', names.buckets.artifact);

        // glue databases
        put('glue/db/metadata', names.glueDatabases.metadata);
        put('glue/db/bronze', names.glueDatabases.bronze);
        put('glue/db/silver', names.glueDatabases.silver);
        put('glue/db/gold', names.glueDatabases.gold);
        put('glue/db/validation', names.glueDatabases.validation);
        put('glue/db/ciSilver', names.glueDatabases.ciSilver);
        put('glue/db/ciGold', names.glueDatabases.ciGold);

        // athena
        put('athena/workgroup', names.athena.workgroup);
        put('athena/outputLocation', names.athena.outputLocation);

        // release ledger (lives in the metadata DB)
        put('release/db', names.release.db);
        put('release/table', names.release.table);

        // roles
        put('roles/glueEtl', names.roles.glueEtl);

        // codebuild / codepipeline
        put('codebuild/dbtTestAndRun', names.codebuild.dbtTestAndRun);
        put('codebuild/dbtReleaseBuilder', names.codebuild.dbtReleaseBuilder);
        put('codepipeline/dbtTestAndRun', names.codepipeline.dbtTestAndRun);
        put('codepipeline/writeReleaseInfo', names.codepipeline.writeReleaseInfo);

        // step functions
        put('stepfunctions/validation', names.stepFunctions.validation);
        put('stepfunctions/writeReleaseJsons', names.stepFunctions.writeReleaseJsons);

        // ec2 (instanceId is published by the EC2 stack — see header comment)
        put('ec2/logGroup', names.ec2.logGroup);
        put('ec2/logBucket', names.ec2.logBucket);
        put('ec2/logPrefix', names.ec2.logPrefix);

        // app facts (INPUTS mirrored for the CLI — snake_case per the toolkit's
        // resolver contract; secret NAMES only, values stay in Secrets Manager)
        put('app/dictionary_version', config.gen3.dictionaryVersion);
        put('app/aws_secret_name', config.gen3.awsSecretName);
        put('app/schema_s3_uri', config.gen3.schemaS3Uri);
        put('app/domain', config.gen3.domain);
        put('app/app_name', config.gen3.appName);
        put('app/namespace', config.gen3.namespace);
        put('app/cluster_name', config.gen3.clusterName);
        put('app/schema_repo', config.gen3.schemaRepo);
    }
}
