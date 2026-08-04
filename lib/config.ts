// lib/config.ts
//
// INPUTS ONLY. Every value here is chosen by a human and committed in
// config/<project>.<env>.json. Names that CDK *creates* (buckets, Glue DBs,
// workgroup, ...) are NOT config — they are derived in lib/names.ts and
// published to SSM Parameter Store on deploy. If you find yourself adding a
// resource name here, it belongs in deriveNames() instead.

/**
 * How the pipeline VPC reaches the Gen3 commons REST API. This varies per
 * environment: test/prod commons are usually internet-facing ("public" — the
 * NAT path just works), while staging commons sit behind an internal ALB that
 * a devops engineer normally exposes via VPN ("peered" — the CDK creates a
 * VPC peering into the Gen3 VPC instead; see docs/VPC_NETWORKING.md §5a for
 * the Gen3-side steps that complete the link).
 */
export interface Gen3ApiAccessConfig {
    mode: 'public' | 'peered';
    /** Gen3 VPC to peer with (required when mode = "peered"). */
    peerVpcId?: string;
    /** That VPC's CIDR, for the route (required when mode = "peered"). */
    peerVpcCidr?: string;
}

/**
 * The pipeline creates its OWN VPC (lib/stacks/network-stack.ts) so it never
 * depends on networks owned by other projects in the account.
 */
export interface NetworkConfig {
    /** Defaults to 10.20.0.0/16 — pick one that does not overlap neighbouring VPCs. */
    vpcCidr?: string;
    /** Defaults to { mode: "public" }. */
    gen3ApiAccess?: Gen3ApiAccessConfig;
}

export interface RepoConfig {
    fullName: string;             // "org/repo"
    branch: string;               // "main"
    codeStarConnectionArn: string;
}

export interface Ec2Config {
    instanceType: string;         // e.g. "t3.micro"
    /**
     * Optional break-glass SSH key pair (must already exist in the account).
     * Normal operation is SSM-only (Session Manager / Run Command) — omit this
     * unless you specifically need SSH access to the job box.
     */
    keyName?: string;
    /** AMI id valid in `region` (e.g. current Amazon Linux 2023). */
    ami: string;
    /**
     * Optional: email to notify when the auto-stop alarm fires (the box is
     * stopped after ~24h below 1% CPU). Creates an SNS topic + subscription;
     * the address must confirm the subscription email once. Omit for
     * stop-only behaviour with no SNS resources.
     */
    alertEmail?: string;
}

/**
 * Gen3 facts consumed by the toolkit/dbt at runtime. Mirrored to SSM under
 * /{project}/{env}/app/* (snake_case) so the CLI can resolve them with only
 * AWS credentials — no repo checkout needed on the EC2 job box.
 */
export interface Gen3Config {
    dictionaryVersion: string;
    awsSecretName: string;        // Secrets Manager secret NAME (never the value)
    schemaS3Uri: string;
    domain: string;
    appName: string;
    namespace: string;
    clusterName: string;
    schemaRepo: string;
}

/**
 * A deployment-supplied Glue python-shell job, declared alongside the built-in
 * jobs without editing any stack code. Still INPUTS only: the deployed job
 * name and S3 scriptLocation are OUTPUTs derived in lib/names.ts from `key`
 * and `scriptFile`. The script file must exist in glue-scripts/ at synth time
 * — a deployment wrapper overlays its own scripts there before synthesizing.
 */
export interface CustomGlueJobConfig {
    /**
     * Stable camelCase slug, unique across built-in and custom jobs. It is the
     * CloudFormation logical id and the lookup key other stacks use — renaming
     * it replaces the deployed job.
     */
    key: string;
    /** Bare filename in glue-scripts/, e.g. "ingest_metadata_templates.py". */
    scriptFile: string;
    /** Kebab-case job-name suffix; defaults to the kebab-cased `key`. */
    nameSuffix?: string;
    /** Extra pip pins appended after the shared toolkit pin set. */
    extraPythonModules?: string[];
    /** Extra --KEY default arguments, merged over the standard set. */
    extraArgs?: Record<string, string>;
    /** DPU override (default 1). */
    maxCapacity?: number;
    /** Timeout override in minutes (default 2880). */
    timeoutMinutes?: number;
}

export interface InputConfig {
    projectId: string;            // e.g. "myproject" — the ONLY place the project name lives
    environment: string;          // "test" | "staging" | "prod"
    accountId: string;
    region: string;

    network?: NetworkConfig;
    repo: RepoConfig;
    ec2: Ec2Config;

    /** Pinned PyPI version of the toolkit, installed on the EC2 box and in Glue jobs. */
    toolkitVersion: string;
    gen3: Gen3Config;

    /** Deployment-specific Glue jobs, in addition to the built-in ones. */
    customJobs?: CustomGlueJobConfig[];
}
