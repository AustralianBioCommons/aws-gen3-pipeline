# config/

Put your real environment configs here as `<projectId>.<environment>.json`,
e.g. `myproject.test.json`. One file per environment; `deploy.sh --env <env>`
selects by the `.<env>.json` suffix.

- Schema: upstream `lib/config.ts` (INPUTS only — resource names are derived,
  never authored here).
- Field-by-field reference: upstream `docs/CONFIG_GUIDE.md`.
- Starting point: upstream `docs/example-config.json` (the init script seeds
  one for you).

These files contain real account IDs and ARNs — that is exactly why this
wrapper repo must stay private.
