# Installed Electron SyncTeX fixture

`baseline.pdf` and `baseline.synctex` are genuine pdfLaTeX/SyncTeX output from
`main.tex` (TeX Live 2026). `rebuilt.*` was compiled after replacing line 6 with
`Second page rebuilt acceptance destination.`. Both documents have two pages;
line 4 maps to page 1 and line 6 to page 2. The PDFs are committed so CI needs
only the runtime `synctex` query tool, not a LaTeX compiler or TeX packages.

Regenerate in a disposable directory with:

```
pdflatex -interaction=batchmode -synctex=-1 main.tex
```

Replace only the first `Input:` source path in the generated sidecar with
`PLACEKEEPER_FIXTURE_SOURCE`. The acceptance copies restore the actual absolute
source filename, including spaces. SyncTeX query checks must pass after this
substitution. External class/package inputs are compiler provenance and are
never targets of the test.

`record-editor.cjs` is launched as a real child process by the saved command
adapter. Its argument records prove process delivery, not placement in a named
editor's UI. No service, query-tool, Electron bridge, or renderer response is
mocked. Native source-configuration dialogs are outside CDP and need separate
platform UI qualification.

The acceptance discovers `synctex` on PATH, with `/Library/TeX/texbin` as a
macOS fallback. CI sets `REQUIRE_SYNCTEX_ACCEPTANCE=1`, so a missing query tool
fails instead of skipping. Only the discovered TeX directory is added to the
isolated application PATH; directories containing Node are rejected by the
harness. This keeps the bundled-Node requirement intact.

The cold-launch case starts the shipped CLI before any Electron process exists
for its unique test root. It observes the production renderer's page and zoom
through `electron-user-data/windows.json`, then observes page movement after a
second CLI request in the same main process with one saved document window.
It does not attach a debugger, take a screenshot, or directly observe the cold
renderer acknowledgement. The warm CDP cases separately check acknowledgement
and displayed toolbar page. Cold cleanup inventories only the exact packaged
executable plus the unique isolated test root, using `ps` on POSIX and
`Win32_Process` on Windows; inventory failures fail explicitly.
