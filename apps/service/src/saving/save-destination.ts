import { basename, dirname, join } from "node:path";

import { validatePdfFilename } from "../files/file-capabilities.js";

export function defaultAnnotatedFilename(sourcePath: string): string {
  const name = basename(sourcePath);
  const stem = name.toLowerCase().endsWith(".pdf") ? name.slice(0, -4) : name;
  return `${stem}-annotated.pdf`;
}

export function proposedCopyPath(sourcePath: string, filename?: string): string {
  return join(
    dirname(sourcePath),
    validatePdfFilename(filename ?? defaultAnnotatedFilename(sourcePath)),
  );
}
