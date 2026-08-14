// lib/stacks/ssm-parameters-stack.ts
//
// Publishes every OUTPUT name (plus the app INPUT facts) to SSM Parameter
// Store under /{project}/{env}/... — the runtime source of truth read by the
// g3dt CLI, CodeBuild, the EC2 job box and Glue. Deployed LAST (build-app.ts
// adds a dependency on every other stack) so a name is never published before
// its resource exists.
//
// WHAT gets published lives in lib/ssm-keys.ts, not here: the same map is read
// by test/ssm-publishing.test.ts and by scripts/integration_test.sh, so the
// synth, the unit test and the live-tree probe can never disagree about the
// tree's shape. This file only turns that map into constructs.
//
// (ec2/instanceId is published by the EC2 stack — its value is a runtime token
// of a replaceable instance, and importing it here would create a cross-stack
// export that blocks instance replacement. See EC2_INSTANCE_ID_KEY.)
//
// test/ssm-publishing.test.ts is the drift guard: add a named resource
// without a matching entry in the map and the suite goes red.
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { InputConfig } from '../config';
import { DerivedNames } from '../names';
import { ssmParameters } from '../ssm-keys';

export interface SsmParametersStackProps extends cdk.StackProps {
    config: InputConfig;
    names: DerivedNames;
}

export class SsmParametersStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: SsmParametersStackProps) {
        super(scope, id, props);

        const { config, names } = props;
        const base = `/${config.projectId}/${config.environment}`;

        // Logical ID is derived from the key, so the ID of an existing
        // parameter is unchanged by how this loop is written — only renaming a
        // key in ssm-keys.ts replaces a deployed parameter.
        for (const [rel, value] of Object.entries(ssmParameters(config, names))) {
            new ssm.StringParameter(this, `P-${rel.replace(/\//g, '-')}`, {
                parameterName: `${base}/${rel}`,
                stringValue: value,
            });
        }
    }
}
