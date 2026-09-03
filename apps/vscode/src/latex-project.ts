import { extname, relative, resolve } from "node:path";

export function isLatexSourcePath(path: string): boolean {
  return [".tex", ".ltx"].includes(extname(path).toLowerCase());
}

export function isPathInside(root: string, candidate: string): boolean {
  const local = relative(resolve(root), resolve(candidate));
  return local === "" || (!local.startsWith("..") && !local.includes("\0"));
}

/** Resolves a broker-validated relative SyncTeX source without allowing it to
 * escape the extension's independently approved workspace root. */
export function containedSourcePath(root: string, candidate: string): string | undefined {
  if (candidate.includes("\0")) return undefined;
  const absolute = resolve(root, candidate);
  return isPathInside(root, absolute) ? absolute : undefined;
}

export function sidecarWatchPattern(outputPath: string): string {
  const name = outputPath.slice(outputPath.lastIndexOf("/") + 1);
  const stem = name.toLowerCase().endsWith(".pdf") ? name.slice(0, -4) : name;
  return `{${name},${stem}.synctex,${stem}.synctex.gz}`;
}
