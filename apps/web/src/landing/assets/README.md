# Landing demo paper

`counterfactual-matrix-means.pdf` contains 33 selected pages from **Estimating Counterfactual Matrix Means with Short Panel Data**, Lihua Lei and Brad Ross, arXiv:2312.07520v3.

- Source: https://arxiv.org/pdf/2312.07520v3
- License: https://creativecommons.org/licenses/by/4.0/
- Main preview: pages 14–16, initially positioned at Section 4.1 on page 14.
- Reference: Appendix A, page 31, PDF destination Y = 175.702.
- Retained original pages: **6–9, 12–19, 25–33, 46–52, 75–79**. These cover pages 14–16 and their directly referenced Sections 2.1–2.2, 3–4, bibliography, Appendix A, Appendix D, and Appendices F.1–F.3. Shared boundary pages preserve section endings.
- Links from pages 14–16 are all retained. On other retained pages, links to omitted material are removed; references are not followed recursively.
- The bundled PDF has only 33 pages. `demo-page-map.json` maps them to original page numbers. The loader inserts blank placeholders **in memory only** so the reader's existing page count, annotation anchors, and navigation still use the original 100-page numbering. The outline is filtered to retained destinations.
- Rebuild with `python scripts/build-demo-excerpt.py /path/to/2312.07520v3.pdf` (requires `pypdf==6.10.0`). The original source is not needed at runtime or stored separately in this tree.
- `reading.png`, `comments.png`, and `references.png` are captures of the production reader using this paper. Comment overlays are illustrative and do not modify the source PDF.

Public attribution and license links are included in the static distribution’s third-party notices.
