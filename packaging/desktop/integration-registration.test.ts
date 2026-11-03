import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerCandidateIntegration, unregisterCandidateIntegration, renderCandidateChromeManifest } from "./integration-registration.js";

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


it("materializes the complete native plugin with installation-scoped paths and reversible ownership", async () => {
  const { candidateCodexPluginFiles } = await import("./integration-registration.js");
  const root = await mkdtemp(join(tmpdir(), "pk-codex-plugin-"));
  const destination = join(root, "marketplace");
  const launcher = join(root, "App's folder", "bin/placekeeper");
  const files = await candidateCodexPluginFiles({ template: join(process.cwd(), "integrations/codex-plugin"), destination, launcher, installationId: "a".repeat(64), platform: "linux" });
  const content = (name: string) => files.find(file => file.path === join(destination, name))!.content;
  expect(JSON.parse(content("codex-plugin/.mcp.json")).mcpServers.placekeeper).toEqual({ command: launcher, args: ["codex-mcp"] });
  const hooks = JSON.parse(content("codex-plugin/hooks/hooks.json"));
  expect(Object.keys(hooks.hooks)).toEqual(["PostToolUse", "UserPromptSubmit", "SessionEnd"]);
  expect(hooks.hooks.PostToolUse[1].matcher).toBe("^mcp__placekeeper__display_review$");
  expect(hooks.hooks.PostToolUse[1].hooks[0].async).toBe(true);
  for (const groups of Object.values(hooks.hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>) for (const group of groups) for (const hook of group.hooks) expect(hook.command).toBe(`'${launcher.replaceAll("'", "'\\''")}' hook --event`);
  const skill = content("codex-plugin/skills/placekeeper/SKILL.md");
  expect(skill).toContain("trusted launch and display hooks report success");
  expect(skill).toContain(`'${launcher.replaceAll("'", "'\\''")}' open --json --surface codex-native`);
  expect(files.some(file => file.path.endsWith("references/live-evidence.md"))).toBe(true);
  expect(files.some(file => file.path.endsWith("scripts/mcp.sh"))).toBe(false);
  expect(JSON.parse(content(".agents/plugins/marketplace.json")).name).toBe(`placekeeper-${"a".repeat(64)}`);
  expect(files.every(file => !file.content.includes("$HOME/Applications/Placekeeper.app"))).toBe(true);
  const receiptPath = join(root, "receipt");
  await registerCandidateIntegration({ installationId: "a".repeat(64), receiptPath, files });
  expect((await unregisterCandidateIntegration(receiptPath, "a".repeat(64))).removed).toHaveLength(files.length);
});

it("renders Windows hooks without shell expansion and preserves the direct Bash launch contract", async () => {
  const { candidateCodexPluginFiles } = await import("./integration-registration.js");
  const root = await mkdtemp(join(tmpdir(), "pk-codex-windows-"));
  const launcher = join(root, "App & $data's folder", "bin/placekeeper.exe");
  const files = await candidateCodexPluginFiles({ template: join(process.cwd(), "integrations/codex-plugin"), destination: join(root, "market"), launcher, installationId: "a".repeat(64), platform: "win32" });
  const hooks = JSON.parse(files.find(file => file.path.endsWith("hooks/hooks.json"))!.content);
  expect(hooks.hooks.UserPromptSubmit[0].hooks[0].commandWindows).toBe(`"${launcher.replaceAll("\\", "/")}" hook --event`);
  expect(files.find(file => file.path.endsWith("SKILL.md"))!.content).toContain(`& '${launcher.replaceAll("\\", "/").replaceAll("'", "''")}' open --json --surface codex-native`);
  await expect(candidateCodexPluginFiles({ template: join(process.cwd(), "integrations/codex-plugin"), destination: join(root, "market"), launcher: join(root, "%expanded%", "placekeeper.exe"), installationId: "a".repeat(64), platform: "win32" })).rejects.toThrow("safely");
});
