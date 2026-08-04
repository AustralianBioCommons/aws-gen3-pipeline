# glue-scripts/

Custom Glue python-shell scripts for the jobs declared under `customJobs` in
your config. At deploy time these are copied over the upstream `glue-scripts/`
directory before synth, so they upload to `s3://<metadata-bucket>/scripts/`
alongside the built-in jobs.

Two rules, both enforced before anything reaches AWS:

1. Every `customJobs[].scriptFile` in config must have a matching `.py` file
   here (or upstream) — a missing file fails at synth.
2. The S3 `scripts/` prefix is pruned to exactly match the deployed directory:
   removing a script here (and its config entry) removes it from S3 on the
   next deploy. That is by design — remove both together.
