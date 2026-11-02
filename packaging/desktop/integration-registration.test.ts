import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerCandidateIntegration, unregisterCandidateIntegration, renderCandidateChromeManifest, renderCandidateCodexToml } from "./integration-registration.js";

describe("explicit candidate registrations", () => {
  it("refuses incumbent files and retains only its own completed writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pk-registration-"));
    const first = join(root, "new"); const incumbent = join(root, "incumbent"); const receiptPath = join(root, "receipt");
    await writeFile(incumbent, "old");
    await expect(registerCandidateIntegration({ installationId: "a".repeat(64), receiptPath, files: [{ path: first, content: "new" }, { path: incumbent, content: "replacement" }] })).rejects.toThrow();
    expect(await readFile(incumbent, "utf8")).toBe("old");
    expect(await unregisterCandidateIntegration(receiptPath, "a".repeat(64))).toEqual({ removed: [first], retained: [] });
    expect(await readFile(incumbent, "utf8")).toBe("old");
  });
  it("does not uninstall edited or another installation's registrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "pk-registration-"));
    const path = join(root, "settings"); const receiptPath = join(root, "receipt");
    await registerCandidateIntegration({ installationId: "a".repeat(64), receiptPath, files: [{ path, content: "candidate" }] });
    await expect(unregisterCandidateIntegration(receiptPath, "b".repeat(64))).rejects.toThrow();
    await writeFile(path, "user edit");
    expect(await unregisterCandidateIntegration(receiptPath, "a".repeat(64))).toEqual({ removed: [], retained: [path] });
  });
  it("retains a replacement registration even when its bytes match", async () => {
    const root = await mkdtemp(join(tmpdir(), "pk-registration-"));
    const path = join(root, "settings"); const receiptPath = join(root, "receipt");
    await registerCandidateIntegration({ installationId: "a".repeat(64), receiptPath, files: [{ path, content: "same" }] });
    const replacement = join(root, "replacement"); await writeFile(replacement, "same"); await rename(replacement, path);
    expect(await unregisterCandidateIntegration(receiptPath, "a".repeat(64))).toEqual({ removed: [], retained: [path] });
  });
  it("preserves native protocol identity and quotes executable paths as JSON", () => {
    const manifest = JSON.parse(renderCandidateChromeManifest('/tmp/candidate app/native-host', "a".repeat(32)));
    expect(manifest.name).toBe("com.placekeeper.chrome");
    expect(manifest.path).toBe('/tmp/candidate app/native-host');
  });
});

describe("owned Windows Chrome registration receipt", () => {
  it("records a unique owner before registry creation and reverses only matching state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pk-registry-")); const path = join(root, "host.json"); const receiptPath = join(root, "receipt");
    let current: { path: string; owner: string; sha256: string } | undefined;
    const driver = {
      async register(path: string, owner: string, sha256: string) { current = { path, owner, sha256 }; },
      async unregister(path: string, owner: string, sha256: string) { return current?.path === path && current.owner === owner && current.sha256 === sha256; },
    };
    await registerCandidateIntegration({ installationId: "a".repeat(64), receiptPath, files: [{ path, content: "manifest" }], chromeRegistry: { path, driver } });
    expect(current?.owner).toMatch(/^[a-f0-9]{64}:[a-f0-9-]{36}$/u);
    expect((await unregisterCandidateIntegration(receiptPath, "a".repeat(64), driver)).removed).toEqual([path]);
  });
  it("retains files and the ownership receipt when a registry key changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pk-registry-")); const path = join(root, "host.json"); const receiptPath = join(root, "receipt");
    const driver = { async register() {}, async unregister() { return false; } };
    await registerCandidateIntegration({ installationId: "a".repeat(64), receiptPath, files: [{ path, content: "manifest" }], chromeRegistry: { path, driver } });
    const result = await unregisterCandidateIntegration(receiptPath, "a".repeat(64), driver);
    expect(result.removed).toEqual([]); expect(result.retained).toContain(path);
    expect(await readFile(path, "utf8")).toBe("manifest");
    expect(await readFile(receiptPath, "utf8")).toContain("registry");
  });
});


it("renders native Codex TOML with quoted bundled runtime paths", () => {
  const content = renderCandidateCodexToml({ node: "/tmp/Candidate App/node/bin/node", server: "/tmp/Candidate App/codex-mcp/server.js", launcher: "/tmp/Candidate App/bin/placekeeper", daemonIdentity: "a".repeat(64), installationId: "b".repeat(64) });
  expect(content).toContain("[mcp_servers.placekeeper]\n");
  expect(content).toContain('command = "/tmp/Candidate App/node/bin/node"');
  expect(content).toContain("[mcp_servers.placekeeper.env]");
  expect(content).not.toContain("mcpServers");
});
