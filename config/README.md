# config/

Environment configs live here as `<projectId>.<environment>.json` — but they
are **gitignored in this repo**: real configs contain account IDs and ARNs and
belong in your private deployment wrapper (see `wrapper-template/` and
`docs/WRAPPER_GUIDE.md`).

- Schema: [`lib/config.ts`](../lib/config.ts) (INPUTS only — resource names
  are derived by `lib/names.ts`, never authored here).
- Starting point: [`docs/example-config.json`](../docs/example-config.json).
- Field-by-field reference: [`docs/CONFIG_GUIDE.md`](../docs/CONFIG_GUIDE.md).

For local experiments you can drop a config here (it stays untracked) and run
`npx cdk synth -c env=<env>`.
