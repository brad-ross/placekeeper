# Representative LaTeX source-work fixture

Build locally from this directory with `latexmk -pdf -synctex=1 paper.tex`. The expected clean output is `paper.pdf`; tests copy it to a separately designated revised-PDF path rather than overwriting review evidence.

The VS Code extension-host runner uses copies of this fixture to exercise manual and automatic builds, replacement by rename, truncate/append, delete/create, same-size writes, sidecar skew, and rapid watcher bursts. The fixture's generated `paper.pdf` is never a Placekeeper save or export target.

The repeated sentence and hostile-looking comments are data used to verify that a task reports ambiguity and ignores embedded instructions.
