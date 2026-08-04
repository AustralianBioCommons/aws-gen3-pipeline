// lib/build-app.ts
// The single place the whole pipeline is wired together. bin/app.ts calls
// this for real deploys; tests call it to synth the exact same graph
// (test/ssm-publishing.test.ts).
//
// Ordering rule: SsmParametersStack is LAST, with an explicit dependency on
// every other stack, so a name is never published before its resource exists
// (the EC2 instanceId is a deploy-time token — publishing it early would fail).
import * as cdk from 'aws-cdk-lib';
import { InputConfig } from './config';
import { DerivedNames, deriveNames } from './names';
import { NetworkStack } from './stacks/network-stack';
import { BucketsStack } from './stacks/buckets-stack';
import { IamRolesStack } from './stacks/iam-roles-stack';
import { ArtifactBucketStack } from './stacks/artifact-bucket-stack';
import { GlueCatalogStack } from './stacks/glue-catalog-stack';
import { GlueJobsStack } from './stacks/glue-jobs-stack';
import { AthenaStack } from './stacks/athena-stack';
import { StepFunctionsStack } from './stacks/stepfunctions-stack';
import { CodeBuildStack } from './stacks/codebuild-stack';
import { CodePipelineStack } from './stacks/codepipeline-stack';
import { Ec2JobRunnerStack } from './stacks/ec2-job-runner-stack';
import { SsmParametersStack } from './stacks/ssm-parameters-stack';

export interface BuiltApp {
    names: DerivedNames;
    stacks: {
        network: NetworkStack;
        buckets: BucketsStack;
        artifactBucket: ArtifactBucketStack;
        iamRoles: IamRolesStack;
        glueCatalog: GlueCatalogStack;
        glueJobs: GlueJobsStack;
        athena: AthenaStack;
        stepFunctions: StepFunctionsStack;
        codeBuild: CodeBuildStack;
        codePipeline: CodePipelineStack;
        ec2: Ec2JobRunnerStack;
        ssm: SsmParametersStack;
    };
}

export function buildApp(app: cdk.App, config: InputConfig): BuiltApp {
    const names = deriveNames(config); // OUTPUT names, computed ONCE
    const env = { account: config.accountId, region: config.region };
    const p = `${config.projectId}-${config.environment}`;
    const common = { env, config, names };

    // The pipeline's own network — created first; nothing is borrowed from
    // other stacks in the account (see docs/VPC_NETWORKING.md).
    const network = new NetworkStack(app, `${p}-network`, common);

    const buckets = new BucketsStack(app, `${p}-buckets`, common);
    const artifactBucket = new ArtifactBucketStack(app, `${p}-artifact-bucket`, common);
    const iamRoles = new IamRolesStack(app, `${p}-iam-roles`, common);
    const glueCatalog = new GlueCatalogStack(app, `${p}-glue-catalog`, common);
    const glueJobs = new GlueJobsStack(app, `${p}-glue-jobs`, {
        ...common,
        glueJobRole: iamRoles.glueJobRole,
    });
    const athena = new AthenaStack(app, `${p}-athena`, common);
    const stepFunctions = new StepFunctionsStack(app, `${p}-stepfunctions`, {
        ...common,
        stepFunctionsRole: iamRoles.stepFunctionsRole,
    });
    const codeBuild = new CodeBuildStack(app, `${p}-codebuild`, {
        ...common,
        vpc: network.vpc,
        securityGroup: network.codeBuildSg,
    });
    const codePipeline = new CodePipelineStack(app, `${p}-codepipeline`, {
        ...common,
        codeBuildProjects: {
            dbtTestAndRun: codeBuild.dbtTestAndRunProject,
            dbtReleaseBuilder: codeBuild.dbtReleaseBuilderProject,
        },
        stepFunctionNames: {
            validation: stepFunctions.validationStateMachineName,
            writeReleaseJsons: stepFunctions.writeReleaseJsonsStateMachineName,
        },
    });

    // The job box the CLI dispatches to
    const ec2 = new Ec2JobRunnerStack(app, `${p}-ec2-job-runner`, {
        ...common,
        vpc: network.vpc,
        securityGroup: network.jobRunnerSg,
    });
    ec2.addDependency(buckets); // its role references the bucket names

    glueCatalog.addDependency(buckets);
    glueJobs.addDependency(glueCatalog);
    athena.addDependency(buckets);
    stepFunctions.addDependency(glueJobs);
    codeBuild.addDependency(athena);
    codePipeline.addDependency(stepFunctions);
    codePipeline.addDependency(artifactBucket);

    // Publish names LAST, after every resource exists. (ec2/instanceId is
    // published by the EC2 stack itself — a cross-stack token would block
    // instance replacement.)
    const ssm = new SsmParametersStack(app, `${p}-ssm-parameters`, {
        env,
        config,
        names,
    });
    [network, buckets, artifactBucket, iamRoles, glueCatalog, glueJobs,
        athena, stepFunctions, codeBuild, codePipeline, ec2]
        .forEach((s) => ssm.addDependency(s));

    return {
        names,
        stacks: {
            network, buckets, artifactBucket, iamRoles, glueCatalog, glueJobs,
            athena, stepFunctions, codeBuild, codePipeline, ec2, ssm,
        },
    };
}
