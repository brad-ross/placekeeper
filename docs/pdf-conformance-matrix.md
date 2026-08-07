# PDF conformance matrix

Last updated: 2026-08-07

The U1 decision gate records viewer and writer outcomes separately. `PASS` means the stated evidence was observed. `PENDING` is a required check that could not run in this environment.

| Surface | Case | Result | Evidence |
| --- | --- | --- | --- |
| EmbedPDF browser viewer 2.14.4 | Native text, reliable geometry, existing Highlight and Stamp inventory | PASS | Playwright `pdf-viewer.conformance.spec.ts`; Chrome; worker-hosted local WASM |
| EmbedPDF browser viewer 2.14.4 | Image-only page refuses semantic anchoring | PASS | Empty canonical text and `reliableTextGeometry: false` |
| EmbedPDF browser viewer 2.14.4 | JavaScript, Launch, URI, and embedded-file content remain inert; no remote requests | PASS | Same-origin CSP harness plus Playwright request/action assertions |
| EmbedPDF browser viewer 2.14.4 | Malformed input fails within the test bound | PASS | Playwright rejects malformed fixture within 1 second |
| EmbedPDF writer 2.14.4 | Replace, Delete, Insert, Highlight with/without comment, and Page Note reopen with stable metadata and appearances | PASS | Vitest structural inspection; Insert uses Text `/Name /Insert` after Preview rejected Caret comment discoverability |
| EmbedPDF writer 2.14.4 | Existing supported Highlight and unsupported Stamp remain unchanged | PASS | Before/after annotation object inventory and equality |
| EmbedPDF writer 2.14.4 | 0/90/180/270-degree cropped-page text-markup geometry | PASS | Reopened segment rectangles equal requested viewer-space rectangles |
| EmbedPDF writer 2.14.4 | CJK, RTL, ligature, soft-hyphen, and combining-character comments | PASS | Exact Unicode `Contents` round trip |
| EmbedPDF writer 2.14.4 | AES-256 encrypted PDF with annotation permission disabled | PASS | Real `/Encrypt` fixture reports print allowed, add-notes denied; writer returns typed `encrypted` failure and no output |
| EmbedPDF writer 2.14.4 | DocMDP certification structure | PASS | AcroForm signature field plus catalog `/Perms /DocMDP`; writer returns typed `signature-restricted` failure and no output |
| Backend host | Original immutability, reopen, digest evidence, source/output limits, cancellation, timeout, malformed input | PASS | Vitest conformance suite |
| Apple Preview 11.0 / macOS 26.5.2 | All intended marks at expected locations | PASS | Manual golden-output inspection on 2026-08-07 |
| Apple Preview 11.0 / macOS 26.5.2 | Every non-empty comment visible in Highlights and Notes | PASS | Manual sidebar inspection on 2026-08-07, including Insert `however` and Page Note comment |
| Adobe Acrobat 26.001.21771 / macOS 26.5.2 | All intended marks at expected locations | PASS | Manual golden-output inspection on 2026-08-07; Insert note, Replace/Delete strikeouts, commented and bare Highlights, Page Note, and pre-existing Highlight/Stamp were visible on page 1 |
| Adobe Acrobat 26.001.21771 / macOS 26.5.2 | Every non-empty comment readable and source annotations present | PASS | Acrobat Comments pane reported 8 entries, including `however`, `locally unique equilibrium`, `Check this argument.`, `Page-level comment.`, existing supported Highlight, and existing unsupported Stamp |

## Automated command

```sh
pnpm test:pdf-conformance
```

The selected writer is EmbedPDF. Both current Acrobat and Apple Preview rows pass, so the external-viewer portion of U1 is complete without a PDFBox adapter.
