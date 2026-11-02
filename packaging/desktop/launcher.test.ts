import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveLauncherRuntime, main, desktopExecutable } from "./launcher.mjs";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const outer = await mkdtemp(join(tmpdir(), "pk-launcher-"));
  const root = join(outer, "resources", "desktop");
  await mkdir(root, { recursive: true });
  await mkdir(join(root, "web"));
  await mkdir(join(root, "node/bin"), { recursive: true });
  await mkdir(join(root, "service"));
  for (const [path, value] of [[`node/bin/node${process.platform === "win32" ? ".exe" : ""}`, "runtime"], ["service/main.js", "cli"], ["web/index.html", "web"], ["web/pdfium.wasm", "packaged wasm"]]) await writeFile(join(root, path!), value!);
  const manifest = { schemaVersion: 1, target: { platform: process.platform, arch: process.arch }, daemonIdentity: "a".repeat(64), installArtifactIdentity: "b".repeat(64), node: { path: `node/bin/node${process.platform === "win32" ? ".exe" : ""}`, sha256: sha("runtime") }, service: { path: "service/main.js", sha256: sha("cli") }, webAssets: { path: "web", files: [{ path: "index.html", sha256: sha("web") }, { path: "pdfium.wasm", sha256: sha("packaged wasm") }] } };
  await writeFile(join(root, "runtime-manifest.json"), JSON.stringify(manifest));
  return root;
}
describe("portable headless launcher", () => {
  it("uses the selected installation independently of the GUI and PATH", async () => {
    const root = await fixture(); const runtime = await resolveLauncherRuntime(root);
    expect(runtime.node).toBe(await realpath(join(root, `node/bin/node${process.platform === "win32" ? ".exe" : ""}`)));
    expect(runtime.environment.PLACEKEEPER_DAEMON_IDENTITY).toBe("a".repeat(64));
  });
  it("uses its verified bundled PDFium asset instead of an inherited checkout path", async () => {
    const root = await fixture(); vi.stubEnv("PLACEKEEPER_PDFIUM_WASM", "/checkout/untrusted/pdfium.wasm");
    try {
      const runtime = await resolveLauncherRuntime(root);
      expect(runtime.environment.PLACEKEEPER_PDFIUM_WASM).toBe(await realpath(join(root, "web/pdfium.wasm")));
      await writeFile(join(root, "web/pdfium.wasm"), "tampered wasm");
      await expect(resolveLauncherRuntime(root)).rejects.toThrow("changed");
    } finally { vi.unstubAllEnvs(); }
  });
  it("fails instead of falling back when packaged runtime bytes change", async () => {
    const root = await fixture(); await writeFile(join(root, `node/bin/node${process.platform === "win32" ? ".exe" : ""}`), "changed");
    await expect(resolveLauncherRuntime(root)).rejects.toThrow("changed");
  });
  it("launches only the opaque correlated id and cancels a failed desktop spawn", async () => {
    const root = await fixture(); await mkdir(dirname(desktopExecutable(root)), { recursive: true }); await writeFile(desktopExecutable(root), "desktop");
    const receipt = { ok: true, kind: "opened", surface: "electron", native: true, launchId: "c".repeat(43), bindProof: "secret-not-for-argv" };
    const calls: unknown[][] = [];
    const invoke = ((...args: unknown[]) => {
      calls.push(args);
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), unref: () => {}, kill: () => {} });
      queueMicrotask(() => {
        if (calls.length === 2) child.emit("error", new Error("desktop missing"));
        else { child.stdout.end(JSON.stringify(receipt)); child.emit("exit", 0); }
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await main(["open", "--json", "--desktop", "electron", "--pdf", "/tmp/review.pdf"], root, invoke)).toBe(2);
      expect(calls[1]?.[1]).toEqual(["--placekeeper-launch", receipt.launchId]);
      expect(calls[2]?.[1]).toEqual([expect.any(String), "electron-cancel-launch", receipt.launchId]);
    } finally { output.mockRestore(); }
  });
  it("rejects another OS target", async () => {
    await expect(resolveLauncherRuntime(await fixture(), { platform: "aix", arch: "unknown" })).rejects.toThrow("manifest");
  });
});
