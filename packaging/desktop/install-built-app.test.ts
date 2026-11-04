import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { installBuiltApp, runtimeRoot } from "./install-built-app.mjs";
import { acquireLifecycleLock } from "../../apps/service/src/host/lifecycle-lock.js";
import { desktopExecutable } from "./launcher.mjs";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function app(path: string) {
  const root = runtimeRoot(path);
  for (const directory of ["node/bin", "service", "web"]) await mkdir(join(root, directory), { recursive: true });
  const node = `node/bin/node${process.platform === "win32" ? ".exe" : ""}`;
  await writeFile(join(root, node), "node");
  await writeFile(join(root, "service/main.js"), "service");
  await writeFile(join(root, "web/pdfium.wasm"), "wasm");
  await mkdir(dirname(desktopExecutable(root)), { recursive: true });
  await writeFile(desktopExecutable(root), "Electron");
  await writeFile(join(root, "runtime-manifest.json"), JSON.stringify({ schemaVersion: 1, target: { platform: process.platform, arch: process.arch }, daemonIdentity: "a".repeat(64), installArtifactIdentity: "b".repeat(64), node: { path: node, sha256: hash("node") }, service: { path: "service/main.js", sha256: hash("service") }, webAssets: { path: "web", files: [{ path: "pdfium.wasm", sha256: hash("wasm") }] } }));
}
describe("desktop replacement transaction", () => {
  it("commits a complete installation only after exact readiness succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "pk-install-success-"));
    try {
      const built = join(root, "built"), installed = join(root, "installed");
      await app(built);
      const readiness = process.platform === "darwin" ? join(installed, "Contents/MacOS/placekeeper") : join(runtimeRoot(installed), "bin", `placekeeper${process.platform === "win32" ? ".exe" : ""}`);
      const lease = await acquireLifecycleLock(join(root, 'lifecycle.lock'));
      const context = { lockPath:join(root,'lifecycle.lock'),lockToken:lease.token,backupRoot:join(root,'backup') };
      const calls: string[][] = [];
      await installBuiltApp(built, installed, readiness, undefined, async (_executable: string, args: string[], options: {env:NodeJS.ProcessEnv}) => { calls.push(args); if(options.env.PLACEKEEPER_STARTUP_REQUEST){const request=JSON.parse(options.env.PLACEKEEPER_STARTUP_REQUEST);await writeFile(request.receipt,JSON.stringify({...request,pid:2147483647,rendererReady:true}));await writeFile(`${request.receipt}.started`,JSON.stringify({...request,pid:2147483647}));} }, undefined, context);
      await lease.release();
      expect(calls.map(args => args[1])).toEqual(["ensure-ready", undefined]);
      expect(await readFile(desktopExecutable(runtimeRoot(installed)), "utf8")).toBe("Electron");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("restores the prior app only after retiring a failed exact-readiness candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "pk-install-"));
    try {
      const built = join(root, "built"), installed = join(root, "installed");
      await app(built); await mkdir(installed); await writeFile(join(installed, "old"), "prior installation");
      const readiness = process.platform === "darwin" ? join(installed, "Contents/MacOS/placekeeper") : join(runtimeRoot(installed), "bin", `placekeeper${process.platform === "win32" ? ".exe" : ""}`);
      const lease = await acquireLifecycleLock(join(root, 'lifecycle.lock'));
      const context = { lockPath:join(root,'lifecycle.lock'),lockToken:lease.token,backupRoot:join(root,'backup') };
      const calls: string[][] = [];
      await expect(installBuiltApp(built, installed, readiness, undefined, async (_executable: string, args: string[]) => {
        calls.push(args);
        if (args[1] === "ensure-ready") { await writeFile(args[3]!, JSON.stringify({pid:2147483647})); throw new Error("readiness failure"); }
      }, undefined, context)).rejects.toThrow("readiness failure");
      await lease.release();
      expect(calls.map(args => args[1])).toEqual(["ensure-ready", "stop-ready"]);
      expect(await readFile(join(installed, "old"), "utf8")).toBe("prior installation");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
