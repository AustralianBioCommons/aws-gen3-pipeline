# Operations detail — mechanisms, failure modes, and why

The layer beneath [OPERATIONS.md](OPERATIONS.md). Read that first for *what to
run*; read this when something behaves unexpectedly, or before changing anything
structural.

Most of what follows was learned by breaking it in production on the legacy
pipeline this platform replaced. Where a gap still exists in this platform it is
marked **GAP**.

---

## 1. Names, SSM, and why nothing is hardcoded

There are exactly two kinds of value: **INPUTS** a human chooses (in
`config/<project>.<env>.json`) and **OUTPUTS** the CDK derives (`lib/names.ts`)
and publishes to SSM under `/{project}/{env}/…`.

Every runtime consumer — the CLI, CodeBuild, the EC2 box, every Glue job —
reads names from SSM. Nothing takes a bucket or database name as an argument.
That is what lets one toolkit version serve every project and environment.

**The drift guard.** `test/ssm-publishing.test.ts` fails if a named resource has
no matching SSM parameter. `g3dt config diff` does the runtime half — comparing
live SSM against the committed config — and **exits 1**, so it can gate CI.

**Failure mode:** if a command touches an unexpected resource, the config is
wrong, not the code. `g3dt config show --env <env>` prints everything resolved;
read it before assuming a bug.

---

## 2. Environments, credentials, and the two-identity model

An environment name selects an SSM tree; the environment's API key selects the
Gen3 commons. **The credential is the environment selector** — there is no URL
for an operator to pass, and therefore none to get wrong.

That design exists because of a real incident. `gen3.auth.Gen3Auth` silently
falls back to the Workspace Token Service whenever an explicitly-passed
`endpoint` disagrees with the credential's `iss`. WTS is not deployed on these
commons, so the call dies with **`502 Bad Gateway` on `/wts/external_oidc/`** —
which reads like broken object links but is purely a client-side mismatch.
Constructing `Gen3Auth(refresh_token=<key>)` with **no** `endpoint` never enters
that branch.

**GAP.** The bare commons URL is not extractable in `g3dt` — it is inlined and
immediately suffixed with `/api/v0`.

**GAP — cross-account topologies.** A deployment can legitimately put the data
plane (buckets, the Athena audit table) in one account and the Gen3 API in
another. The legacy pipeline handles this with an env pairing one account's AWS
profile with the other's API key. `g3dt` cannot express it: `resolve_env`
resolves against SSM `/{project}/{base}/…`, and a compound env name has no tree.

---

## 3. CI builds vs release builds

Both pipelines run `dbt build`. Historically both wrote to the **same** Glue
databases, which caused two distinct problems:

1. **Write races.** Concurrent builds against the same Iceberg tables risk
   commit conflicts, and a release can pin a snapshot produced by a *different
   commit* than the tagged one.
2. **A snapshot-retention time bomb.** Every CI run advanced the warehouse
   tables' snapshots. Releases pin snapshot IDs; snapshot expiration walking
   forward past a pinned snapshot **silently destroys the reproducibility of
   that release**. With CI isolated, warehouse snapshots advance only at release
   time, so pins stay valid.

### The rule, and the direction it must point

Only the **`ci` target** is remapped:

| Target | Used by | Writes to |
|---|---|---|
| `ci` | the commit-triggered pipeline (`G3DT_DBT_TARGET=ci`) | `ci_<project>_<env>_raw_{silver,gold}_db` |
| default | the release pipeline, and local runs | the real warehouse |

The direction matters more than it looks. The **first** attempt at this inverted
it — prefixing every non-`prod` target and pointing the release build at
`--target prod`, which resolved to a pre-existing, never-used profile aimed at a
dead bucket and **broke a release build at `dbt debug`**. The rule had to become
"only `ci` is special; the default behaves exactly as it always did."

There is also no `ci_` **bronze** database, and that is deliberate: bronze is an
input to the platform, not a product of it. See [DATA_LAYERS.md](DATA_LAYERS.md).

`find_db_for_model` in the toolkit skips `ci_` databases, so the release writer
can never pin a CI snapshot even if one exists.

### **GAP** — the release build has no CI wait-gate

Isolation does not make this redundant. It stops CI writing to the warehouse; it
does not stop the *release* pipeline's own build racing a commit that lands
mid-release. The fix is a bounded poll for in-progress CI builds in the release
buildspec, where **only the release side waits** (mutual waiting deadlocks) and
a missing IAM permission **warns and skips rather than failing the release**.

That last part degrades silently, and did: the gate was a no-op for several
releases until the role was granted CodeBuild read access. If you add the gate,
grant the permission in the same change.

---

## 4. Validation

The validator derives its work from the silver database — it lists tables
matching `silver_<study>_*` to discover studies, dumps each to JSON, and
validates against the Gen3 schema.

**Naming is load-bearing.** A table that does not match the convention is not
validated, and nothing reports that it was skipped.

**The gate fails the job**, and therefore the Step Function, when real failures
remain in the latest `validation_id` — known-noise error patterns and synthetic
studies excluded. A warning would have been ignored; a failure means a green run
carries information.

**Operator loop:** gate fails → inspect `full_validation_results` for the latest
`validation_id` → fix the source data → re-run until green.

Two things learned building it, worth remembering when editing:

- The exclude list once had **a missing comma**, which silently un-excluded two
  tables. Python's implicit string concatenation makes this class of bug
  invisible in review.
- The deployed Glue script had been **edited in the console**, away from the
  repo, so the reviewed behaviour and the deployed behaviour had diverged. This
  repo's `glue-scripts/` is the single source of truth precisely so that cannot
  recur.

---

## 5. Releases, pinned snapshots, and reproducibility

A data release records, per model, the Iceberg **snapshot ID** it was built
from. The export then reads *that* snapshot — which is what makes a release
reproducible months later.

**The bug this replaced:** the exporter unconditionally fetched the *latest*
snapshot, silently overwriting the pinned one. Every release exported current
data rather than the recorded snapshot, and nothing looked wrong. The fix guards
the fetch on `snapshot_id` being unset.

**Performance principle.** The same root cause produced both major Glue
speedups: **a redundant per-model Athena metadata query**. The exporter ran a
`$snapshots` query per model (~24 min → 1.7 min for 114 tables once removed and
parallelised); the validation writer ran a redundant *third* `$snapshots` query
per table purely to name an S3 path, about a third of its runtime. When a job is
slow, count the Athena calls per unit of work before adding workers.

### **GAP** — the toolkit-pin coupling is manual

A library fix reaches a Glue job only via **all three of**: a PyPI release, a
`toolkitVersion` bump in the config, and the `glue-scripts/` copy in S3 being
updated. Miss one and the job silently runs old code. Nothing checks this.

---

## 6. Dispatch: how a job actually runs on EC2

`g3dt <cmd> --on ec2` does **not** ship your working tree. The box runs a
pinned, pip-installed toolkit and the remote command is a bare `g3dt <subcommand>`
console-script call, which re-enters the same code path with `on=local`.

Consequences worth knowing:

- **There is no repo on the box to drift**, and no `git pull` in the path. The
  toolkit version is whatever CDK pinned. (The legacy monolith did `cd repo &&
  git pull && poetry run …`; this model is deliberately simpler for handover.)
- **Confirmation happens locally, before dispatch.** SSM has no TTY, so a remote
  prompt would hang forever. Any typed prod confirmation is resolved on your
  laptop and only then is the job sent.
- **Remote argv is `shlex.quote`d.** Arguments containing spaces or shell
  metacharacters are safe. (The monolith does *not* do this — that is one of the
  two places this platform is ahead.)
- Logs go to `~/.g3dt/logs/<run-id>.log` on the box and stream via
  `g3dt jobs logs <run-id> --follow`.

---

## 7. Destructive operations

### Guards

- `is_prod(env)` is `"prod" in env.lower()`.
- **Production always requires typing the target exactly**, even with `--yes`.
- `--version all` always prompts, regardless of `--yes`.
- The typed string is an **attention gate, not an information channel**. Keep it
  short enough to retype accurately — a prompt that aborts the whole command on
  any mismatch trains a copy-paste reflex if it is long, which defeats it.

### How deletion actually works

Two entirely different mechanisms:

**A specific version** — for each node, in **reverse** `DataImportOrder`
(children before parents, because Gen3 enforces referential integrity), query
the audit table for `project_id` + `version` + `api_endpoint`, extract
`gen3_guid`, then call `delete_record` **one GUID at a time**. Batch size is
rate-limiting only, not a bulk endpoint.

**`all`** — no Athena at all: `delete_nodes()` per node, wiping every record of
that node type in the project regardless of version.

**The audit table is the source of truth, not Gen3.** Anything submitted outside
the pipeline, or whose audit row is missing, is invisible to the delete and
survives.

### **GAP** — three traps in the current implementation

1. A `v`-prefixed or malformed version matches zero rows, exits 3, and is
   reported as **skipped** — indistinguishable from a healthy no-op.
2. `--version` is one global value, so studies at different versions need one
   job each.
3. Uploads are purely additive with no duplicate check — the legacy deployment
   has a version sitting at exactly 2× its expected record count from an
   unnoticed re-run.

---

## 8. Indexd and the download gate

Registration is **not idempotent**, despite what the docstring says. `baseid` is
a deterministic UUIDv5 of the filename, so re-submitting creates a **new revision
with a new `did`**, and the registry (merging on `did`) inserts a row every run.
On the legacy deployment this produced 46,598 rows for 23,295 unique files.

Downstream joins must therefore de-duplicate by `registered_at`
(`ROW_NUMBER() … ORDER BY registered_at DESC`) — and that stays necessary even
once a skip is added, because of the revisions already accumulated.

**Registration succeeding does not mean files download.** The signed-URL step
needs `read-storage` on the record's authz resource, which is a *separate* grant
from the `create` used to register and submit. On the legacy production commons
every object returned `401` at that step while registration and submission
worked perfectly — every `object_id` link in the release would have been dead on
arrival, discoverable only by user report.

Interpreting a failed check: `404` = not registered; empty `urls` = no storage
location; **`401` = authorization gap, not a broken key**; `500` = Fence fault.

**GAP.** No `check-download` equivalent exists in `g3dt`.

---

## See also

- [OPERATIONS.md](OPERATIONS.md) — the day-to-day quick guide
- [DATA_LAYERS.md](DATA_LAYERS.md) — the layer contract and ingestion tools
- [CONFIG_GUIDE.md](CONFIG_GUIDE.md) — every INPUT field
- [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) — deploy workflow and stack map
- [VPC_NETWORKING.md](VPC_NETWORKING.md) — networking and Gen3 access modes
