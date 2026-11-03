import { hashFile } from "../../apps/service/src/files/file-capabilities.js";
import { createRequire } from "node:module";
import { readFile, readdir, realpath, stat, mkdir, copyFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export function archiveExtraction(platform: NodeJS.Platform, archive: string, destination: string): { command: string; args: string[] } {
  // Windows 11 ships bsdtar, which supports ZIP archives. GNU tar on Linux does not.
  if (platform === "win32") return { command: "tar.exe", args: ["-xf", archive, "-C", destination] };
  if (!archive.endsWith(".tar.gz")) throw new Error("ZIP runtime extraction requires a native Windows build host");
  return { command: "tar", args: ["-xzf", archive, "-C", destination] };
}

export async function inventory(root: string, directory = root): Promise<Array<{ path: string; sha256: string }>> {
  const files: Array<{ path: string; sha256: string }> = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(root, path));
    else if (entry.isFile()) files.push({ path: relative(root, path).replaceAll("\\", "/"), sha256: await hashFile(path) });
    else throw new Error(`Unexpected packaged resource: ${path}`);
  }
  return files;
}

interface PackageMetadata { name: string; version: string; license?: unknown; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
async function dependencyDirectory(name: string, from: string): Promise<string> {
  const require = createRequire(join(from, "package.json"));
  // Resolving the package directory directly also supports packages whose exports hide package.json.
  for (const base of require.resolve.paths(name) ?? []) {
    const candidate = join(base, name);
    if (await stat(join(candidate, "package.json")).then(() => true, () => false)) return realpath(candidate);
  }
  throw new Error(`Cannot find dependency ${name} from ${from}`);
}

export async function bundleDependencyNotices(repo: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await copyFile(join(repo, "THIRD_PARTY_NOTICES.md"), join(destination, "THIRD_PARTY_NOTICES.md"));
  const visited = new Set<string>();
  const packages: Array<{ name: string; version: string; license: unknown; notices: string[] }> = [];
  async function visit(directory: string): Promise<void> {
    if (visited.has(directory)) return;
    visited.add(directory);
    const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as PackageMetadata;
    const id = `${metadata.name.replaceAll("/", "_")}@${metadata.version}`;
    const notices: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^(?:licen[cs]e|copying|notice|copyright)(?:[.-].*)?$/iu.test(entry.name)) continue;
      const output = join(destination, id, entry.name);
      await mkdir(dirname(output), { recursive: true });
      await copyFile(join(directory, entry.name), output);
      notices.push(`${id}/${entry.name}`);
    }
    if (notices.length === 0) throw new Error(`No dependency license/notice file found for ${id}`);
    packages.push({ name: metadata.name, version: metadata.version, license: metadata.license ?? null, notices: notices.sort() });
    for (const name of Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies }).sort()) {
      let child: string;
      try { child = await dependencyDirectory(name, directory); }
      catch (error) { if (metadata.optionalDependencies?.[name] !== undefined) continue; throw error; }
      await visit(child);
    }
  }
  const root = JSON.parse(await readFile(join(repo, "package.json"), "utf8")) as PackageMetadata;
  for (const name of Object.keys(root.dependencies ?? {}).sort()) await visit(await dependencyDirectory(name, repo));
  packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"));
  await writeFile(join(destination, "dependencies.json"), `${JSON.stringify(packages, null, 2)}\n`);
}

/** Adapt the shared Mac host helper to its colocated portable payload. Fail
 * loudly if its packaging boundary changes rather than retaining a host zip. */
export function portableVscodePackager(source: string): string {
  const archiveCall = "await run('/usr/bin/zip', ['-q', '-X', archive, ...entries], { cwd: staging, env: { ...process.env, TZ: 'UTC' } });";
  if (!source.includes(archiveCall) || !source.includes("resolve(appPath, 'Contents/Resources/")) throw new Error("The shared VSIX packager changed; update its portable adapter");
  return `import { writeZip } from './portable-zip.mjs';\n` + source
    .replaceAll("resolve(appPath, 'Contents/Resources/", "resolve(import.meta.dirname, '../")
    .replace(archiveCall, "await writeZip(archive, staging, entries);");
}

export function portableIntegrationSetup(source: string): string {
  const legacy = "if (host === 'codex') return { host, ...await setupCodex({ appPath, run }) };";
  if (!source.includes(legacy)) throw new Error("The shared Codex setup helper changed; update its portable adapter");
  return `import { setupPortableCodex } from './setup-codex.mjs';\n${source.replace(legacy, "if (host === 'codex') return { host, ...await setupPortableCodex({ resources: resolve(import.meta.dirname, '..'), run }) };")}`;
}
