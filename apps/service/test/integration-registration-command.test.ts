import { cp, mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/platform/windows-native-worker.js", () => ({ requestWindowsNative: native.request }));
vi.mock("../../../packaging/macos/chrome-integration.js", () => ({ validateChromeSourceContract: () => ({}) }));
import { runIntegrationRegistrationCommand } from "../src/cli/integration-registration-command.js";
const realProcess = process;
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("explicit candidate integration command", () => {
  it("registers and reverses the Windows Chrome HKCU endpoint through owned native operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "pk-windows-chrome-cli-"));
    const host = join(root, "bin/placekeeper-chrome-native-host.exe");
    const extension = join(root, "integrations/chrome-extension");
    for (const file of [host, ...["manifest.json", "handler.html", "popup.html", "background.js", "shared/asset-manifest.json"].map(file => join(extension, file))]) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, "{}"); }
    const receipt = join(root, "ownership.json"); const destination = join(root, "chrome-profile/com.placekeeper.chrome.json");
    vi.stubEnv("PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY", "a".repeat(64));
    vi.stubGlobal("process", new Proxy(realProcess, { get(target, property) { return property === "platform" ? "win32" : Reflect.get(target, property); } }));
    native.request.mockResolvedValue({ status: "ok" });
    const output: string[] = [];
    expect(await runIntegrationRegistrationCommand(["integration-registration", "chrome", "--receipt", receipt, "--destination", destination, "--native-host", host], text => output.push(text))).toBe(0);
    expect(native.request).toHaveBeenCalledWith(expect.objectContaining({ operation: "registerChromeHost", path: destination, owner: expect.stringMatching(/^[a-f0-9]{64}:[a-f0-9-]{36}$/u) }));
    expect(JSON.parse(await readFile(destination, "utf8")).name).toBe("com.placekeeper.chrome");
    native.request.mockResolvedValue({ status: "failed", nativeCode: 183 });
    expect(await runIntegrationRegistrationCommand(["integration-registration", "remove", "--receipt", receipt], text => output.push(text))).toBe(2);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ ok: false, status: "retained" });
    expect(await readFile(destination, "utf8")).toContain("com.placekeeper.chrome");
  });
  it("registers the complete Codex plugin against this identified bundled runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "pk-codex-config-cli-"));
    const node = join(root, `node/bin/node${process.platform === "win32" ? ".exe" : ""}`); const server = join(root, "codex-mcp/server.js"); const launcher = join(root, `bin/placekeeper${process.platform === "win32" ? ".exe" : ""}`);
    for (const path of [node, server, launcher]) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, "asset"); }
    await cp(join(process.cwd(), "integrations/codex-plugin"), join(root, "integrations/codex-plugin-template"), { recursive: true });
    vi.stubEnv("PLACEKEEPER_APP_RESOURCES", root);
    vi.stubEnv("PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY", "a".repeat(64)); vi.stubEnv("PLACEKEEPER_DAEMON_IDENTITY", "b".repeat(64));
    const destination = join(root, "marketplace"); const output: string[] = [];
    expect(await runIntegrationRegistrationCommand(["integration-registration", "codex", "--receipt", join(root, "receipt"), "--destination", destination, "--node", node, "--server", server, "--launcher", launcher], text => output.push(text))).toBe(0);
    expect(JSON.parse(await readFile(join(destination, "codex-plugin/.mcp.json"), "utf8")).mcpServers.placekeeper).toEqual({ command: await realpath(launcher), args: ["codex-mcp"] });
    expect(await readFile(join(destination, "codex-plugin/hooks/hooks.json"), "utf8")).toContain("Verifying Placekeeper native presentation");
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ ok: true, trust: "pending" });
    expect(native.request).not.toHaveBeenCalled();
  });
});
