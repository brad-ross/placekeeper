# Representative LaTeX handoff fixture

Build locally from this directory with `latexmk -pdf -synctex=1 paper.tex`. The expected clean output is `paper.pdf`; tests copy it to the handoff's designated `paper-revised.pdf` path rather than overwriting review evidence.

The repeated sentence and hostile-looking comments are data used to verify that a task reports ambiguity and ignores embedded instructions.
