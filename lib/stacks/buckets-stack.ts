// lib/stacks/buckets-stack.ts
// The six data buckets. Names come from deriveNames() — never authored.
import { Stack, StackProps, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { InputConfig } from "../config";
import { DerivedNames } from "../names";

export interface BucketsStackProps extends StackProps {
    config: InputConfig;
    names: DerivedNames;
}

export class BucketsStack extends Stack {
    public readonly bronze: s3.Bucket;
    public readonly silver: s3.Bucket;
    public readonly gold: s3.Bucket;
    public readonly metadata: s3.Bucket;
    public readonly validation: s3.Bucket;
    public readonly athenaResults: s3.Bucket;

    constructor(scope: Construct, id: string, props: BucketsStackProps) {
        super(scope, id, props);

        const { buckets } = props.names;

        const mk = (logicalId: string, bucketName: string) =>
            new s3.Bucket(this, logicalId, {
                bucketName,
                encryption: s3.BucketEncryption.S3_MANAGED,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                enforceSSL: true,
                versioned: true,
                removalPolicy: RemovalPolicy.RETAIN,
                autoDeleteObjects: false,
            });

        this.bronze = mk("bronze", buckets.bronze);
        this.silver = mk("silver", buckets.silver);
        this.gold = mk("gold", buckets.gold);
        this.metadata = mk("metadata", buckets.metadata);
        this.validation = mk("validation", buckets.validation);
        this.athenaResults = mk("athena-results", buckets.athenaResults);
    }
}
