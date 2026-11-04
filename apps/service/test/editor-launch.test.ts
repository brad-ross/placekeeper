import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { launchEditorNavigation, resolveNavigationExecutable } from "../src/synctex/editor-launch.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(() => {
  const child = { once: vi.fn((name: string, callback: () => void) => { if (name === "spawn") queueMicrotask(callback); return child; }), unref: vi.fn() };
  return child;
}) }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-editor-launch-"))); roots.push(root);
  const resources = join(root, process.platform === "darwin" ? "Placekeeper.app/Contents/Resources/desktop" : "resources/desktop");
  const executable = process.platform === "darwin" ? join(dirname(dirname(resources)), "MacOS/PlacekeeperDesktop") : join(root, process.platform === "win32" ? "PlacekeeperDesktop.exe" : "PlacekeeperDesktop");
  const hash = (content: string) => createHash("sha256").update(content).digest("hex");
  for (const [path, content] of [["node/bin/node", "node"], ["service/main.js", "service"], ["web/app.js", "web"]]) {
    await mkdir(dirname(join(resources, path!)), { recursive: true }); await writeFile(join(resources, path!), content!);
  }
  await mkdir(dirname(executable), { recursive: true }); await writeFile(executable, "desktop");
  const identity = "a".repeat(64);
  await writeFile(join(resources, "runtime-manifest.json"), JSON.stringify({ schemaVersion: 1, target: { platform: process.platform, arch: process.arch },
    daemonIdentity: "b".repeat(64), installArtifactIdentity: identity, node: { path: "node/bin/node", sha256: hash("node"), version: "24" },
    service: { path: "service/main.js", sha256: hash("service"), version: "1" }, webAssets: { path: "web", files: [{ path: "app.js", sha256: hash("web") }] } }));
  return { root, resources, executable, identity };
}
it("launches only the verified installation executable with a literal navigation argument", async () => {
  const f = await fixture(); const ticket = "t".repeat(43);
  const daemonArgs = ["--isolated-installed-smoke", "--http-port", "43210", "--isolated-test-root", f.root];
  await launchEditorNavigation(ticket, f.resources, f.identity, daemonArgs);
  expect(spawn).toHaveBeenCalledWith(f.executable, ["--placekeeper-navigation", ticket, ...daemonArgs], { detached: true, stdio: "ignore", shell: false });
});
it("rejects another installation, changed runtime assets and an executable symlink", async () => {
  const f = await fixture();
  await expect(resolveNavigationExecutable(f.resources, "c".repeat(64))).rejects.toThrow("identity");
  await writeFile(join(f.resources, "service/main.js"), "changed");
  await expect(resolveNavigationExecutable(f.resources, f.identity)).rejects.toThrow("digest");
  await writeFile(join(f.resources, "service/main.js"), "service");
  await rm(f.executable); await symlink(process.execPath, f.executable);
  await expect(resolveNavigationExecutable(f.resources, f.identity)).rejects.toThrow("executable");
  expect(spawn).not.toHaveBeenCalled();
});
