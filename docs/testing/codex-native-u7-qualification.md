# Native Codex installation qualification (U7)

The October 5, 2026 normal update installed the tested app and refreshed the existing Codex plugin to `0.1.0+codex.20261005000000`. Cached manifest, skill, evidence reference and MCP registration matched the installed payload. Following a full host reload, the new skill and native display tool were available. A fresh native review rendered, and a real prompt delivered current review context matching the panel indicator.

The installer deferred while a native review was active and preserved its work. A full Codex restart released participation. Setup continued to report host discovery, trust and reload as pending until separately verified. An ordinary browser review also rendered and searched after the update without depending on a Codex task binding.

All 134 distinct installer, distribution, source-release, registry and daemon tests have passing evidence. The installer dry-run initially timed out while the macOS build competed for resources; its standalone rerun passed in 57.51 seconds. Type checking, candidate packaging and isolated installed smoke passed.

See [structured evidence](codex-native-u7-qualification.json) for observations and limits. Live user plugin disable/removal was not performed; existing disabled-state tests and native-runtime teardown/browser checks cover those boundaries. Manual host removal remains documented. Full corpus, performance and composed lifecycle acceptance remain U8.
