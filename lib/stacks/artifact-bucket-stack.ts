// lib/stacks/artifact-bucket-stack.ts
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { InputConfig } from '../config';
import { DerivedNames } from '../names';

export interface ArtifactBucketStackProps extends cdk.StackProps {
    config: InputConfig;
    names: DerivedNames;
}

export class ArtifactBucketStack extends cdk.Stack {
    public readonly artifactBucket: s3.Bucket;

    constructor(scope: Construct, id: string, props: ArtifactBucketStackProps) {
        super(scope, id, props);

        this.artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
            bucketName: props.names.buckets.artifact,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            versioned: true,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });
    }
}
