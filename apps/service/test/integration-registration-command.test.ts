import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
  it("writes actual Codex TOML against explicit bundled assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "pk-codex-config-cli-"));
    const node = join(root, "node"); const server = join(root, "server.js"); const launcher = join(root, "placekeeper");
    for (const path of [node, server, launcher]) await writeFile(path, "asset");
    vi.stubEnv("PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY", "a".repeat(64)); vi.stubEnv("PLACEKEEPER_DAEMON_IDENTITY", "b".repeat(64));
    const destination = join(root, "config.toml"); const output: string[] = [];
    expect(await runIntegrationRegistrationCommand(["integration-registration", "codex", "--receipt", join(root, "receipt"), "--destination", destination, "--node", node, "--server", server, "--launcher", launcher], text => output.push(text))).toBe(0);
    expect(await readFile(destination, "utf8")).toContain("[mcp_servers.placekeeper]");
    expect(native.request).not.toHaveBeenCalled();
  });
});
