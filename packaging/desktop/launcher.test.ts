import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
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
    expect(runtime.environment.PLACEKEEPER_APP_RESOURCES).toBe(await realpath(root));
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
  it("resolves the production executable on each supported OS", () => {
    expect(desktopExecutable("/app/Contents/Resources/desktop", "darwin")).toBe("/app/Contents/MacOS/PlacekeeperDesktop");
    expect(desktopExecutable("/app/resources/desktop", "linux")).toBe("/app/PlacekeeperDesktop");
    expect(desktopExecutable("/app/resources/desktop", "win32")).toBe("/app/PlacekeeperDesktop.exe");
  });
  it("defaults ordinary opens to desktop and preserves an explicit browser surface", async () => {
    const root = await fixture();
    await mkdir(dirname(desktopExecutable(root)), { recursive: true }); await writeFile(desktopExecutable(root), "desktop");
    const calls: unknown[][] = [];
    const receipt = { ok: true, kind: "opened", surface: "electron", native: true, launchId: "d".repeat(43) };
    const invoke = ((...args: unknown[]) => {
      calls.push(args);
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), unref() {}, kill() {} });
      queueMicrotask(() => { child.stdout.end(JSON.stringify(receipt)); child.emit("spawn"); child.emit("exit", 0); });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await main(["open", "--json", "--pdf", "/tmp/review.pdf"], root, invoke)).toBe(0);
      expect(calls[0]?.[1]).toEqual([expect.any(String), "open", "--json", "--pdf", "/tmp/review.pdf", "--desktop", "electron"]);
      expect(calls[1]?.[2]).toMatchObject({ env: { PLACEKEEPER_APP_RESOURCES: await realpath(root) } });
      calls.length = 0;
      expect(await main(["open", "--json", "--surface", "browser", "--pdf", "/tmp/review.pdf"], root, invoke)).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).not.toContain("--desktop");
    } finally { output.mockRestore(); }
  });
  it.each(["view-source", "zed-forward", "zed-build"])("dispatches %s through this installation's bundled editor adapter", async command => {
    const root = await fixture();
    await mkdir(join(root, "integrations/editors"), { recursive: true });
    await writeFile(join(root, "integrations/editors/zed-adapter.mjs"), "export {};");
    const args = [command, "spaces and café", "--line", "3"];
    const calls: unknown[][] = [];
    const invoke = ((...invocation: unknown[]) => {
      calls.push(invocation);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 7));
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    expect(await main(args, root, invoke)).toBe(7);
    const runtime = await resolveLauncherRuntime(root);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(runtime.node);
    expect(calls[0]?.[1]).toEqual(["--input-type=module", "--eval", expect.stringContaining("await adapter[process.argv[2]]"),
      expect.stringContaining("/integrations/editors/zed-adapter.mjs"), command === "view-source" ? "runViewSource" : "runZed",
      String(process.ppid), runtime.environment.PLACEKEEPER_LAUNCHER, JSON.stringify(args)]);
    expect(calls[0]?.[2]).toMatchObject({ shell: false, stdio: "inherit", env: {
      PLACEKEEPER_APP_RESOURCES: await realpath(root), PLACEKEEPER_DAEMON_IDENTITY: "a".repeat(64),
      PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY: "b".repeat(64),
    } });
  });
  it.each([
    ["choose-source-folder", "folder"], ["choose-source-pdf", "pdf"], ["choose-neovim-endpoint", "endpoint"],
  ])("routes %s to this desktop's bounded native chooser", async (command, kind) => {
    const root = await fixture();
    await mkdir(dirname(desktopExecutable(root)), { recursive: true }); await writeFile(desktopExecutable(root), "desktop");
    const calls: unknown[][] = [];
    const invoke = ((...invocation: unknown[]) => {
      calls.push(invocation);
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill() {} });
      queueMicrotask(() => { child.stdout.end(JSON.stringify({ selected: null })); child.emit("exit", 0); });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const args = kind === "endpoint" ? [command!] : [command!, root];
    try {
      expect(await main(args, root, invoke)).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe(desktopExecutable(root));
      expect(calls[0]?.[1]).toEqual(["--placekeeper-choose", kind, ...args.slice(1)]);
      expect(calls[0]?.[2]).toMatchObject({ shell: false, env: { PLACEKEEPER_APP_RESOURCES: await realpath(root) } });
      expect(output).toHaveBeenCalledWith('{"selected":null}\n');
    } finally { output.mockRestore(); }
  });
  it("rejects oversized chooser output instead of forwarding it", async () => {
    const root = await fixture();
    await mkdir(dirname(desktopExecutable(root)), { recursive: true }); await writeFile(desktopExecutable(root), "desktop");
    const kill = vi.fn();
    const invoke = (() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill });
      queueMicrotask(() => { child.stdout.end("x".repeat(16385)); child.emit("exit", 0); });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await main(["choose-neovim-endpoint"], root, invoke)).toBe(2);
      expect(kill).toHaveBeenCalled();
      expect(output).toHaveBeenCalledWith(expect.stringContaining('"ok":false'));
    } finally { output.mockRestore(); }
  });
  it("serves MCP only through the manifest-verified bundled server and exact runtime environment", async () => {
    const root = await fixture();
    await mkdir(join(root, "codex-mcp")); await writeFile(join(root, "codex-mcp/server.js"), "verified server");
    const path = join(root, "runtime-manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.codexMcp = { path: "codex-mcp/server.js", sha256: sha("verified server") };
    await writeFile(path, JSON.stringify(manifest));
    const calls: unknown[][] = [];
    const invoke = ((...invocation: unknown[]) => {
      calls.push(invocation);
      const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 9)); return child;
    }) as unknown as typeof import("node:child_process").spawn;
    expect(await main(["codex-mcp"], root, invoke)).toBe(9);
    expect(calls[0]?.[1]).toEqual([await realpath(join(root, "codex-mcp/server.js"))]);
    expect(calls[0]?.[2]).toMatchObject({ shell: false, stdio: "inherit", env: { PLACEKEEPER_APP_RESOURCES: await realpath(root) } });
    calls.length = 0;
    await writeFile(join(root, "codex-mcp/server.js"), "tampered server");
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await main(["codex-mcp"], root, invoke)).toBe(2);
      expect(calls).toHaveLength(0);
    } finally { output.mockRestore(); }
  });
  it("rejects MCP when its server has no manifest digest", async () => {
    const root = await fixture(), invoke = vi.fn();
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await main(["codex-mcp"], root, invoke as unknown as typeof import("node:child_process").spawn)).toBe(2);
      expect(invoke).not.toHaveBeenCalled();
    } finally { output.mockRestore(); }
  });
  it("rejects another OS target", async () => {
    await expect(resolveLauncherRuntime(await fixture(), { platform: "aix", arch: "unknown" })).rejects.toThrow("manifest");
  });
});
