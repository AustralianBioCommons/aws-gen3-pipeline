# Contributing

Thanks for improving this template. Two rules keep it useful and safe to keep public.

## Where does my change belong?

| Change | Where it goes |
|---|---|
| New stack capabilities, bug fixes, docs, tests — anything **generic** | A PR to this repo |
| Real deployment configs, org-specific Glue jobs/scripts, account details — anything **deployment-specific** | Your **private deployment wrapper** (see [docs/WRAPPER_GUIDE.md](docs/WRAPPER_GUIDE.md)) — never committed here |

If a change only makes sense for your organisation's deployment, it belongs in the
wrapper. If any deployer of the template would want it, send a PR.

## PR expectations

- **`npm test` is green.** Run `npm run build && npm test` before pushing — CI runs the
  same steps.
- **Conventional Commits** ([1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)):
  `feat: …`, `fix: …`, `docs: …`, etc.
- **No real identifiers, anywhere in the commit** — no real AWS account IDs, ARNs,
  VPC/subnet/AMI ids, connection UUIDs, or hostnames. Use the documented placeholders
  (account `123456789012`, `vpc-0123456789abcdef0`, `commons.example.org`, …). CI greps
  every push for common patterns and fails on hits, but it is a backstop, not a
  substitute for care.
- **Tests follow the existing style**: prioritise logic and readability over coverage,
  show clear inputs and expected outputs, and carry docstrings/comments with enough
  background that a new developer understands *why* the test matters.

## Configs and fixtures

- `config/*.json` is **gitignored on purpose** — real configs live in private wrapper
  repos, and local dev configs must never land in this public repo.
- Tests that need a config use the committed fixture
  [`test/fixtures/pipeline-config.json`](test/fixtures/pipeline-config.json)
  (placeholder values only). Extend the fixture rather than adding new config files.

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
