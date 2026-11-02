import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashFile } from "../../apps/service/src/files/file-capabilities.js";
import { resolvePackagedRuntime, type PackagedRuntimeManifest } from "../../apps/service/src/platform/runtime-layout.js";
import type { PackagedBuildIdentity } from "./build-app.js";

export const MAC_RUNTIME_MANIFEST_FILENAME = "runtime-manifest.json";

interface RecoveryBuildMetadata {
  readonly schemaVersion: 1;
  readonly service: { readonly path: "main.js"; readonly sha256: string };
  readonly recovery: { readonly readableDraftSchemaVersions: readonly number[]; readonly writtenDraftSchemaVersion: number };
}

/** Only newly built retained bundles carry a service-owned declaration bound to
 * the exact reader bytes. Older installed applications are never probed. */
export async function writeRetainedMacRuntimeManifest(options: {
  readonly resources: string;
  readonly identity: PackagedBuildIdentity;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly serviceVersion: string;
}): Promise<PackagedRuntimeManifest> {
  const root = options.resources;
  const serviceHash = await hashFile(join(root, "service/main.js"));
  const metadata = JSON.parse(await readFile(join(root, "service/recovery-capabilities.json"), "utf8")) as RecoveryBuildMetadata;
  const recovery = metadata.recovery;
  if (metadata.schemaVersion !== 1 || metadata.service?.path !== "main.js" || metadata.service.sha256 !== serviceHash ||
      !recovery || !Array.isArray(recovery.readableDraftSchemaVersions) || recovery.readableDraftSchemaVersions.length === 0 ||
      !recovery.readableDraftSchemaVersions.every(version => Number.isSafeInteger(version) && version > 0) ||
      new Set(recovery.readableDraftSchemaVersions).size !== recovery.readableDraftSchemaVersions.length ||
      !Number.isSafeInteger(recovery.writtenDraftSchemaVersion) || !recovery.readableDraftSchemaVersions.includes(recovery.writtenDraftSchemaVersion)) {
    throw new Error("Retained Mac service has no matching recovery reader build metadata");
  }
  const files: { path: string; sha256: string }[] = [];
  async function inventory(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name); const relative = prefix + entry.name;
      if (entry.isDirectory()) await inventory(path, `${relative}/`);
      else if (entry.isFile()) files.push({ path: relative, sha256: await hashFile(path) });
      else throw new Error("Retained Mac assets must contain only regular files and directories");
    }
  }
  await inventory(join(root, "web"), "");
  const manifest: PackagedRuntimeManifest = {
    schemaVersion: 1,
    target: { platform: "darwin", arch: options.arch },
    daemonIdentity: options.identity.daemonIdentity,
    installArtifactIdentity: options.identity.installArtifactIdentity,
    node: { path: "node/bin/node", sha256: await hashFile(join(root, "node/bin/node")), version: options.nodeVersion },
    service: { path: "service/main.js", sha256: serviceHash, version: options.serviceVersion },
    webAssets: { path: "web", files },
    recovery,
  };
  await resolvePackagedRuntime(root, manifest, options.identity, { platform: "darwin", arch: options.arch });
  await writeFile(join(root, MAC_RUNTIME_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return manifest;
}
