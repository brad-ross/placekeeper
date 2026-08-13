# Placekeeper pre-rebrand compatibility fixtures

These fixtures model two legacy installation contracts; they do not contain or execute an unpublished legacy application binary.

- `transactional-pre-rebrand` is pinned to commit `4cc17cea25aff0dd2be5d317ca5c44117751a395`, the immediate pre-rebrand baseline. Its replacement mode is the coordinated transaction.
- `pre-management-handshake` is pinned to commit `f3d91b395e82424b271943d91eb296d9b06bba93`, the parent of the management-handshake change. Its replacement mode requires the documented, ownership-checked `daemon stop-legacy` step before the current transaction helper runs.

`baselines.json` records the exact source commit and date for each descriptive baseline. It is itself one of the self-contained fixture artifacts whose digest is recorded in `manifest.json`; the harness verifies every listed artifact before materializing either baseline into a temporary home. These digests authenticate the repository-owned fixture inputs, not files fetched from mutable Git history. On macOS, existing packaging tests physically execute the current `install-built-app.sh`; legacy daemon behavior is a deterministic contract model only.
