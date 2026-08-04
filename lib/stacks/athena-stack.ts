// lib/stacks/athena-stack.ts
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as athena from 'aws-cdk-lib/aws-athena';
import { InputConfig } from '../config';
import { DerivedNames } from '../names';

export interface AthenaStackProps extends cdk.StackProps {
    config: InputConfig;
    names: DerivedNames;
}

export class AthenaStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: AthenaStackProps) {
        super(scope, id, props);

        const { athena: athenaNames } = props.names;

        new athena.CfnWorkGroup(this, 'WorkGroup', {
            name: athenaNames.workgroup,
            workGroupConfiguration: {
                resultConfiguration: {
                    outputLocation: athenaNames.outputLocation,
                    encryptionConfiguration: { encryptionOption: 'SSE_S3' },
                },
                enforceWorkGroupConfiguration: true,
            },
            state: 'ENABLED',
        });
    }
}
