import { extname, relative, resolve } from "node:path";

export function isLatexSourcePath(path: string): boolean {
  return [".tex", ".ltx"].includes(extname(path).toLowerCase());
}

export function isPathInside(root: string, candidate: string): boolean {
  const local = relative(resolve(root), resolve(candidate));
  return local === "" || (!local.startsWith("..") && !local.includes("\0"));
}

export function sidecarWatchPattern(outputPath: string): string {
  const name = outputPath.slice(outputPath.lastIndexOf("/") + 1);
  const stem = name.toLowerCase().endsWith(".pdf") ? name.slice(0, -4) : name;
  return `{${name},${stem}.synctex,${stem}.synctex.gz}`;
}
