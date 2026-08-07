import { basename, extname } from "node:path";

export function reviewedPdfFilename(
  originalPath: string,
  collisionIndex = 0,
): string {
  const name = basename(originalPath);
  const extension = extname(name);
  const stem = extension.length === 0 ? name : name.slice(0, -extension.length);
  const suffix = collisionIndex === 0 ? "" : `-${collisionIndex + 1}`;
  return `${stem}-reviewed${suffix}.pdf`;
}
