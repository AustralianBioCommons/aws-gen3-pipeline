// lib/stacks/glue-catalog-stack.ts
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as glue from 'aws-cdk-lib/aws-glue';
import { InputConfig } from '../config';
import { DerivedNames } from '../names';

export interface GlueCatalogStackProps extends cdk.StackProps {
    config: InputConfig;
    names: DerivedNames;
}

export class GlueCatalogStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: GlueCatalogStackProps) {
        super(scope, id, props);

        const { buckets, glueDatabases } = props.names;
        const catalogId = this.account;

        const makeDb = (
            id: string,
            name: string,
            bucketName: string,
            description: string,
        ) =>
            new glue.CfnDatabase(this, id, {
                catalogId,
                databaseInput: {
                    name,
                    description,
                    locationUri: `s3://${bucketName}/`,
                },
            });

        makeDb('BronzeDb', glueDatabases.bronze, buckets.bronze, 'Bronze layer');
        makeDb('SilverDb', glueDatabases.silver, buckets.silver, 'Silver layer');
        makeDb('GoldDb', glueDatabases.gold, buckets.gold, 'Gold layer');
        const metadataDb = makeDb(
            'MetadataDb',
            glueDatabases.metadata,
            buckets.metadata,
            'DataOps metadata',
        );
        makeDb(
            'ValidationDb',
            glueDatabases.validation,
            buckets.validation,
            'Validation results',
        );
        // CI isolation: the dbt template's `ci` target builds into these —
        // same buckets, data under a dbt_ci/ prefix. Real databases above
        // keep their names; only the ci target is ever prefixed. The ci
        // databases exist for silver and gold because CI rebuilds those
        // layers; bronze is never rebuilt by dbt, so it has no ci twin.
        makeDb(
            'CiSilverDb',
            glueDatabases.ciSilver,
            `${buckets.silver}/dbt_ci`,
            'CI dbt builds (isolated from the silver warehouse)',
        );
        makeDb(
            'CiGoldDb',
            glueDatabases.ciGold,
            `${buckets.gold}/dbt_ci`,
            'CI dbt builds (isolated from the gold warehouse)',
        );

        // NOTE: the `releases` ledger is deliberately NOT created here. It is
        // an Iceberg table, and Iceberg tables cannot be meaningfully seeded
        // by CloudFormation (a plain Glue CfnTable entry makes Athena's
        // Iceberg engine fail with "Cannot find or access the specified
        // table" — found live 2026-07-15). `g3dt release write` creates it
        // idempotently (CREATE TABLE IF NOT EXISTS) on the first release;
        // its name is still published to SSM as release/db + release/table.
    }
}
