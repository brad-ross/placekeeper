# PDF backend decision

- Date: 2026-08-07
- Status: Selected; Acrobat Reader and Apple Preview interoperability rows pass
- Viewer: EmbedPDF browser-worker engine 2.14.4
- Writer: EmbedPDF/PDFium Node engine 2.14.4

## Decision

Use the all-TypeScript EmbedPDF path for both viewing and writing. Keep the project-owned writer port in `packages/core` and the EmbedPDF implementation in `packages/pdf-backends`. Do not add PDFBox, Java, or a second verifier unless a later blocking conformance result reopens the fallback gate.

Export the five review intents as standard PDF annotations:

| Review intent | PDF representation |
| --- | --- |
| Replace | StrikeOut with proposed replacement in `Contents` |
| Delete | StrikeOut |
| Insert | Text annotation with `/Name /Insert` and proposed text in `Contents` |
| Highlight | Highlight |
| Page Note | Text annotation with `/Name /Note` |

The Insert representation is an evidence-driven variance from the plan's provisional Caret mapping. Preview rendered a Caret but omitted its non-empty `Contents` from the Highlights and Notes list. The standard Text annotation with the Insert icon preserves the insertion location and exposes the proposed text in Preview. For this small trusted-user app, that is simpler and more interoperable than adding a Java writer or a paired Popup object solely to compensate for Preview's Caret behavior.

## Evidence

- The browser-worker viewer extracts native text and selection rectangles, inventories existing Highlight and Stamp annotations, refuses semantic anchoring on an image-only page, keeps JavaScript, launch actions, URI actions, and embedded content inert, makes no remote request, and bounds malformed-file failure.
- The writer emits and reopens all five representations with stable IDs, comments, authors, print flags, and normal appearances. It preserves pre-existing supported and unsupported annotations, the original bytes, crop/rotation geometry at 0/90/180/270 degrees, and Unicode comments.
- A genuinely AES-256 encrypted fixture with annotation permission disabled and a DocMDP certification fixture both fail closed without output.
- Backend-host tests cover digest mismatch, source/output size caps, cancellation, timeout, typed failures, output digest evidence, and structural reopen.
- Apple Preview 11.0 on macOS 26.5.2 renders every intended mark and exposes every non-empty review comment, including the Insert note, in its Highlights and Notes sidebar.
- Adobe Acrobat Reader 26.001.21771 on macOS 26.5.2 renders every intended mark at the expected location and exposes every non-empty review comment in its Comments pane. The pre-existing Highlight and Stamp remain present. Together with the passing Apple Preview rows, this signs off the external-viewer portion of U1.

## Packaging consequences

Package Node 24.14.0, the pinned EmbedPDF packages, the application code/assets, and the pinned local PDFium WASM listed in `packaging/macos/backend-runtime-manifest.json`. No Java runtime, Gradle build, PDFBox JAR, or Java signing/notarization path is included.

## Rejected path

PDFBox 3.0.8 was not implemented because the EmbedPDF writer passed the automated and available Preview gates. The original Caret-only Insert representation was rejected because Preview did not expose its proposed text to the reviewer.
