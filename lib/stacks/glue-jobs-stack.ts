// lib/stacks/glue-jobs-stack.ts
// Python-shell Glue jobs, one per entry in names.glueJobs. Runtime settings
// are fixed here (they are engine facts, not per-env choices); the toolkit
// pin follows config.toolkitVersion.
//
// Jobs deliberately run WITHOUT a VPC connection: connection-less python-shell
// jobs use Glue's managed network, which already has internet access (pip,
// public Gen3 endpoints). Attaching a NETWORK connection would move job ENIs
// into the VPC and make every job depend on a NAT route for no gain — only
// reintroduce one if a job must reach private-IP resources or needs a stable
// egress IP (see docs/VPC_NETWORKING.md).
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { InputConfig } from '../config';
import { DerivedNames } from '../names';

const GLUE_VERSION = '3.0';
const PYTHON_VERSION = '3.9';
const MAX_CAPACITY_DPU = 1;
const TIMEOUT_MINUTES = 2880;

export interface GlueJobsStackProps extends cdk.StackProps {
    config: InputConfig;
    names: DerivedNames;
    glueJobRole: iam.IRole;
}

export class GlueJobsStack extends cdk.Stack {
    public readonly jobNames: string[];

    constructor(scope: Construct, id: string, props: GlueJobsStackProps) {
        super(scope, id, props);

        const { config, names, glueJobRole } = props;

        // Pin the heavy transitive deps alongside the toolkit: with a bare
        // package pin, Glue python-shell's pip spends ~20 minutes in
        // dependency-resolver backtracking (observed live: successive boto3
        // metadata downloads) before the job's own code even starts. The
        // pinned versions are the set a successful resolution actually chose.
        const toolkitPin = [
            `gen3-dataops-toolkit==${config.toolkitVersion}`,
            'awswrangler==3.14.0',
            'boto3==1.41.5',
            'pandas==2.3.3',
            'numpy==1.26.4',
            'pyarrow==18.1.0',
            // Read .xlsx for the metadata-template ingest job. Pinned like the
            // rest so pip cannot start backtracking; harmless for the jobs that
            // do not import it.
            'openpyxl==3.1.5',
        ].join(',');

        // The job scripts live in this repo (glue-scripts/) and are deployed
        // to s3://<metadata-bucket>/scripts/ on every `cdk deploy` — no manual
        // upload step. `prune: true` keeps the prefix exactly in sync with the
        // directory, so a renamed/removed script cannot linger in S3.
        //
        // That prune makes a missing file dangerous: a job configured without
        // its script would deploy fine and then delete nothing-or-worse from
        // S3. Fail at synth instead — every job's script must be present in
        // glue-scripts/ (deployment wrappers overlay theirs before synth).
        const scriptsDir = path.join(__dirname, '..', '..', 'glue-scripts');
        for (const jobDef of names.glueJobs) {
            const file = path.basename(jobDef.scriptLocation);
            if (!fs.existsSync(path.join(scriptsDir, file))) {
                throw new Error(
                    `Glue job "${jobDef.key}" needs glue-scripts/${file}, which does not exist. ` +
                    'Add the script (wrappers: put it in your glue-scripts/ overlay) or remove the job.',
                );
            }
        }

        const metadataBucket = s3.Bucket.fromBucketName(
            this, 'MetadataBucket', names.buckets.metadata,
        );
        new s3deploy.BucketDeployment(this, 'GlueScripts', {
            sources: [s3deploy.Source.asset(scriptsDir)],
            destinationBucket: metadataBucket,
            destinationKeyPrefix: 'scripts/',
            prune: true,
        });

        this.jobNames = [];

        for (const jobDef of names.glueJobs) {
            const job = new glue.CfnJob(this, `GlueJob-${jobDef.key}`, {
                name: jobDef.name,
                role: glueJobRole.roleArn,
                glueVersion: GLUE_VERSION,
                executionProperty: {
                    maxConcurrentRuns: 1,
                },
                maxCapacity: jobDef.maxCapacity ?? MAX_CAPACITY_DPU,
                command: {
                    name: 'pythonshell',
                    pythonVersion: PYTHON_VERSION,
                    scriptLocation: jobDef.scriptLocation,
                },
                defaultArguments: {
                    '--enable-metrics': 'true',
                    '--enable-continuous-cloudwatch-log': 'true',
                    '--additional-python-modules':
                        [toolkitPin, ...(jobDef.extraPythonModules ?? [])].join(','),
                    '--job-language': 'python',
                    // Preinstalled analytics libs (pandas/awswrangler) — same
                    // as the proven legacy jobs; pip only adds the toolkit.
                    'library-set': 'analytics',
                    // The scripts' whole config contract: everything else is
                    // resolved from SSM /{PROJECT_ID}/{ENV}/... via g3dt.
                    '--PROJECT_ID': config.projectId,
                    '--ENV': config.environment,
                    '--REGION': config.region,
                    // Custom-job extras last so a wrapper can also override the
                    // standard set deliberately (e.g. pin --REGION for a test).
                    ...(jobDef.extraArgs ?? {}),
                },
                timeout: jobDef.timeoutMinutes ?? TIMEOUT_MINUTES,
            });

            this.jobNames.push(job.name ?? jobDef.name);
        }
    }
}
