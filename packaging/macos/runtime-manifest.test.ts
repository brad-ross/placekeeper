import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePackagedRuntime } from "../../apps/service/src/platform/runtime-layout.js";
import { computePackagedBuildIdentity } from "./build-app.js";
import { writeRetainedMacRuntimeManifest } from "./runtime-manifest.js";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture(metadata = true) {
  const app = await mkdtemp(join(tmpdir(), "pk-retained-mac-"));
  const contents = join(app, "Contents"); const resources = join(contents, "Resources");
  for (const path of ["node/bin", "service", "web"]) await mkdir(join(resources, path), { recursive: true });
  await writeFile(join(resources, "node/bin/node"), "signed independent node bytes");
  await writeFile(join(resources, "service/main.js"), "exact service bytes");
  await writeFile(join(resources, "web/index.html"), "shared app");
  if (metadata) await writeFile(join(resources, "service/recovery-capabilities.json"), JSON.stringify({ schemaVersion: 1, service: { path: "main.js", sha256: digest("exact service bytes") }, recovery: { readableDraftSchemaVersions: [1, 2, 3], writtenDraftSchemaVersion: 3 } }));
  const identity = await computePackagedBuildIdentity({ contentsRoot: contents, serviceRoot: join(resources, "service"), webRoot: join(resources, "web") });
  return { contents, resources, identity, arch: "arm64", nodeVersion: "24.14.0", serviceVersion: "same-app-version-does-not-prove-reader" };
}
describe("retained native Mac recovery reader manifests", () => {
  it("records exact signed runtime bytes and current Mac service identity without changing that identity", async () => {
    const options = await fixture(); const manifest = await writeRetainedMacRuntimeManifest(options);
    expect(manifest.daemonIdentity).toBe(options.identity.daemonIdentity);
    expect(manifest.recovery?.readableDraftSchemaVersions).toEqual([1, 2, 3]);
    expect(await computePackagedBuildIdentity({ contentsRoot: options.contents, serviceRoot: join(options.resources, "service"), webRoot: join(options.resources, "web") })).toEqual(options.identity);
    const runtime = await resolvePackagedRuntime(options.resources, manifest, options.identity, { platform: "darwin", arch: "arm64" });
    expect(runtime.serviceEntry).toContain("service/main.js");
    expect(JSON.parse(await readFile(join(options.resources, "runtime-manifest.json"), "utf8"))).toEqual(manifest);
  });
  it("refuses older payloads lacking a service-bound declaration without executing their code", async () => {
    await expect(writeRetainedMacRuntimeManifest(await fixture(false))).rejects.toThrow("ENOENT");
  });
  it("refuses reused build metadata after service bytes change", async () => {
    const options = await fixture(); await writeFile(join(options.resources, "service/main.js"), "other reader with the same app version");
    await expect(writeRetainedMacRuntimeManifest(options)).rejects.toThrow("matching recovery reader");
  });
  it("detects Node or web mutations before a retained reader can be selected", async () => {
    const options = await fixture(); const manifest = await writeRetainedMacRuntimeManifest(options);
    await writeFile(join(options.resources, "node/bin/node"), "changed interpreter");
    await expect(resolvePackagedRuntime(options.resources, manifest, options.identity, { platform: "darwin", arch: "arm64" })).rejects.toThrow("digest mismatch");
  });
});
