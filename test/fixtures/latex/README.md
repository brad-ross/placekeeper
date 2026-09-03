# Representative LaTeX source-work fixture

Build locally from this directory with `latexmk -pdf -synctex=1 paper.tex`. The expected clean output is `paper.pdf`; tests copy it to a separately designated revised-PDF path rather than overwriting review evidence.

The VS Code extension-host runner uses copies of this fixture to exercise manual and automatic builds, replacement by rename, truncate/append, delete/create, same-size writes, sidecar skew, and rapid watcher bursts. The fixture's generated `paper.pdf` is never a Placekeeper save or export target.

The repeated sentence and hostile-looking comments are data used to verify that a task reports ambiguity and ignores embedded instructions.

For the installed two-rebuild acceptance, work on a copy and keep `paper.pdf` as the canonical generated output:

1. Build the baseline with SyncTeX enabled. Add Review Items to the repeated sentence, the unambiguous sentence, and the cycle-one removal sentence; leave one pending composer draft.
2. Cycle one: change `\placekeeperbuildlabel` to `cycle-one`, remove the sentence explicitly marked for cycle one, revise the unambiguous sentence, and rebuild. The same panel must refresh; the repeated anchor is ambiguous, the removed anchor is missing, and the unambiguous item is resolved or current according to its edit.
3. Save the source once without producing a valid successor (or quiesce a partial candidate). The prior PDF, mixed reconciliation outcomes, and pending draft must remain visible with a **possibly stale** status.
4. Cycle two: change `\placekeeperbuildlabel` to `cycle-two`, edit only the cycle-two sentence, and rebuild by rename or ordinary LaTeX Workshop replacement. The same panel must return to current without silently retargeting unresolved work.
5. Verify forward and reverse SyncTeX after each valid generation. Resolve remaining feedback, export a distinct reviewed PDF, and confirm `paper.pdf` is byte-identical to the generated input observed immediately before export.

The opt-in LaTeX Workshop route and the supported Placekeeper-command fallback use this same sequence. Do not overwrite `paper.pdf` with the reviewed export.
