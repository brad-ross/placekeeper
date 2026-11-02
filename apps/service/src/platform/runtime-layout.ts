import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface RuntimeIdentity {
  readonly daemonIdentity: string;
  readonly installArtifactIdentity: string;
}
interface RuntimeFile {
  readonly path: string;
  readonly sha256: string;
}
export interface PackagedRuntimeManifest extends RuntimeIdentity {
  readonly schemaVersion: 1;
  readonly target: { readonly platform: NodeJS.Platform; readonly arch: string };
  readonly node: RuntimeFile & { readonly version: string };
  readonly service: RuntimeFile & { readonly version: string };
  readonly webAssets: { readonly path: string; readonly files: readonly RuntimeFile[] };
}
export interface PackagedRuntimeInstallation {
  readonly root: string;
  readonly manifest: PackagedRuntimeManifest;
  readonly expectedIdentity: RuntimeIdentity;
}

/** Verify the installation before choosing an executable; never search PATH. */
export async function resolvePackagedRuntime(
  root: string,
  manifest: PackagedRuntimeManifest,
  expected: RuntimeIdentity,
  target = { platform: process.platform, arch: process.arch as string },
) {
  if (manifest.schemaVersion !== 1 || manifest.target.platform !== target.platform || manifest.target.arch !== target.arch) {
    throw new Error("Packaged runtime target mismatch");
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.daemonIdentity) || !/^[a-f0-9]{64}$/u.test(manifest.installArtifactIdentity) ||
    manifest.daemonIdentity !== expected.daemonIdentity || manifest.installArtifactIdentity !== expected.installArtifactIdentity) {
    throw new Error("Packaged runtime identity mismatch");
  }
  const physicalRoot = await realpath(root);
  async function containedPath(base: string, path: string): Promise<string> {
    if (isAbsolute(path) || path.includes("\0")) throw new Error("Invalid packaged runtime path");
    const candidate = await realpath(resolve(base, path));
    const suffix = relative(base, candidate);
    if (suffix === "" || suffix === ".." || suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(suffix)) {
      throw new Error("Packaged runtime path escapes its installation");
    }
    return candidate;
  }
  async function verify(base: string, file: RuntimeFile) {
    const path = await containedPath(base, file.path);
    if (!(await stat(path)).isFile()) throw new Error(`Packaged runtime is not a file: ${file.path}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest("hex") !== file.sha256) throw new Error(`Packaged runtime digest mismatch: ${file.path}`);
    return path;
  }
  if (!manifest.node.version || !manifest.service.version || manifest.webAssets.files.length === 0) {
    throw new Error("Packaged runtime versions and assets are required");
  }
  const nodeExecutable = await verify(physicalRoot, manifest.node);
  const serviceEntry = await verify(physicalRoot, manifest.service);
  const webAssetsRoot = await containedPath(physicalRoot, manifest.webAssets.path);
  if (await realpath(resolve(dirname(serviceEntry), "../web")) !== webAssetsRoot) {
    throw new Error("Packaged manifest does not identify the service's served assets");
  }
  for (const file of manifest.webAssets.files) await verify(webAssetsRoot, file);
  const expectedAssets = new Set(manifest.webAssets.files.map((file) => resolve(webAssetsRoot, file.path)));
  async function verifyAssetInventory(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await verifyAssetInventory(path);
      else if (!entry.isFile() || !expectedAssets.delete(path)) throw new Error(`Unidentified packaged asset: ${path}`);
    }
  }
  await verifyAssetInventory(webAssetsRoot);
  if (expectedAssets.size !== 0) throw new Error("Packaged asset inventory mismatch");
  return { nodeExecutable, serviceEntry, webAssetsRoot, daemonIdentity: expected.daemonIdentity, installArtifactIdentity: expected.installArtifactIdentity };
}
