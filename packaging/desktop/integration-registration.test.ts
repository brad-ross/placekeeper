import { chmod, mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerCandidateIntegration, repairCandidateIntegration, unregisterCandidateIntegration, renderCandidateChromeManifest } from "./integration-registration.js";

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
  expect(files.some(file => file.path.endsWith(join("references", "live-evidence.md")))).toBe(true);
  expect(files.some(file => file.path.endsWith(join("scripts", "mcp.sh")))).toBe(false);
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
  const hooks = JSON.parse(files.find(file => file.path.endsWith(join("hooks", "hooks.json")))!.content);
  expect(hooks.hooks.UserPromptSubmit[0].hooks[0].commandWindows).toBe(`"${launcher.replaceAll("\\", "/")}" hook --event`);
  expect(files.find(file => file.path.endsWith("SKILL.md"))!.content).toContain(`& '${launcher.replaceAll("\\", "/").replaceAll("'", "''")}' open --json --surface codex-native`);
  await expect(candidateCodexPluginFiles({ template: join(process.cwd(), "integrations/codex-plugin"), destination: join(root, "market"), launcher: join(root, "%expanded%", "placekeeper.exe"), installationId: "a".repeat(64), platform: "win32" })).rejects.toThrow("safely");
});

it("repairs an owned previous artifact but refuses edited registrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-repair-"));
  const receiptPath = join(root, "receipt"); const path = join(root, "host");
  await registerCandidateIntegration({ installationId: "a".repeat(64), receiptPath, files: [{ path, content: "old" }] });
  expect(await repairCandidateIntegration({ installationId: "b".repeat(64), receiptPath, files: [{ path, content: "new" }] })).toBe("repaired");
  expect(await readFile(path, "utf8")).toBe("new");
  expect(await repairCandidateIntegration({ installationId: "b".repeat(64), receiptPath, files: [{ path, content: "new" }] })).toBe("current");
  await writeFile(path, "user edit");
  await expect(repairCandidateIntegration({ installationId: "c".repeat(64), receiptPath, files: [{ path, content: "replacement" }] })).rejects.toThrow("changed");
  expect(await readFile(path, "utf8")).toBe("user edit");
});
it("keeps owning unchanged registrations after macOS renumbers their volume device", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-remount-"));
  const receiptPath = join(root, "receipt"); const path = join(root, "host");
  await registerCandidateIntegration({ installationId: "a".repeat(64), receiptPath, files: [{ path, content: "owned" }] });
  // Simulate a reboot that mounted the same volume under a different st_dev.
  const renumber = async () => {
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.files = receipt.files.map((file: { device: number }) => ({ ...file, device: file.device + 2 }));
    await writeFile(receiptPath, JSON.stringify(receipt));
  };
  await renumber();
  expect(await repairCandidateIntegration({ installationId: "a".repeat(64), receiptPath, files: [{ path, content: "owned" }] })).toBe("current");
  expect(await repairCandidateIntegration({ installationId: "b".repeat(64), receiptPath, files: [{ path, content: "refreshed" }] })).toBe("repaired");
  await renumber();
  expect(await unregisterCandidateIntegration(receiptPath, "b".repeat(64))).toEqual({ removed: [path], retained: [] });
});
it('checks an unchanged Windows registry receipt without removing its host registration', async () => {
 const root=await mkdtemp(join(tmpdir(),'pk-chrome-current-'));const path=join(root,'host');const receiptPath=join(root,'receipt');
 let writes=0;let removals=0;let inspections=0;
 const driver={async register(){writes++;},async unregister(){removals++;return true;},async matches(){inspections++;return true;}};
 const options={installationId:'a'.repeat(64),receiptPath,files:[{path,content:'manifest'}],chromeRegistry:{path,driver}};
 await registerCandidateIntegration(options);
 expect(await repairCandidateIntegration(options)).toBe('current');
 expect({writes,removals,inspections}).toEqual({writes:1,removals:0,inspections:1});
});
it('refreshes a changed plugin inventory while preserving unowned additions', async () => {
 const root=await mkdtemp(join(tmpdir(),'pk-inventory-'));const receiptPath=join(root,'receipt');const old=join(root,'old');const added=join(root,'added');
 await registerCandidateIntegration({installationId:'a'.repeat(64),receiptPath,files:[{path:old,content:'owned'}]});
 await writeFile(added,'user file');
 await expect(repairCandidateIntegration({installationId:'b'.repeat(64),receiptPath,files:[{path:added,content:'new'}]})).rejects.toThrow();
 expect(await readFile(old,'utf8')).toBe('owned');expect(await readFile(added,'utf8')).toBe('user file');
 const next=join(root,'next');
 expect(await repairCandidateIntegration({installationId:'b'.repeat(64),receiptPath,files:[{path:next,content:'new'}]})).toBe('repaired');
 await expect(readFile(old)).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(next,'utf8')).toBe('new');expect(await readFile(added,'utf8')).toBe('user file');
});
it('retries an absent Chrome key after failed registration without removing an incumbent', async () => {
 const root=await mkdtemp(join(tmpdir(),'pk-chrome-retry-'));const path=join(root,'host');const receiptPath=join(root,'receipt');
 let attempts=0;let present=false;let removals=0;
 const driver={async register(){attempts++;if(attempts===1)throw Error('Temporary registration failure');if(present)throw Error('Incumbent key');present=true;},async unregister(){removals++;return false;},async matches(){return present;}};
 const options={installationId:'a'.repeat(64),receiptPath,files:[{path,content:'manifest'}],chromeRegistry:{path,driver}};
 await expect(repairCandidateIntegration(options)).rejects.toThrow('Temporary registration failure');
 expect(await repairCandidateIntegration(options)).toBe('current');
 expect({attempts,present,removals}).toEqual({attempts:2,present:true,removals:0});
 expect(await repairCandidateIntegration(options)).toBe('current');expect(attempts).toBe(2);
});

describe("Claude Desktop configuration merge", () => {
  const entry = (root: string) => ({ command: join(root, "app/node/bin/node"), args: [join(root, "app/codex-mcp/server.js")], env: { PLACEKEEPER_MCP_HOST: "claude-desktop", PLACEKEEPER_APP_RESOURCES: join(root, "app"), PLACEKEEPER_LAUNCHER: join(root, "app/bin/placekeeper") } });
  const fixture = async (content?: string) => {
    const root = await mkdtemp(join(tmpdir(), "pk-claude-")); const folder = join(root, "Claude"); await mkdir(folder);
    const configPath = join(folder, "claude_desktop_config.json"); if (content !== undefined) await writeFile(configPath, content, { mode: 0o644 });
    await chmod(configPath, 0o644).catch(() => {});
    return { root, configPath, receiptPath: join(root, "state/claude.receipt.json") };
  };
  const others = { theme: "dark", mcpServers: { filesystem: { command: "npx", args: ["-y", "fs"] } }, preferences: { quickEntry: true } };
  it("merges a fresh entry beside other servers and keeps the file mode", async () => {
    const { root, configPath, receiptPath } = await fixture(JSON.stringify(others));
    const { registerClaudeDesktopServer, renderClaudeDesktopServer } = await import("./integration-registration.js");
    const rendered = renderClaudeDesktopServer({ node: entry(root).command, server: entry(root).args[0]!, resources: join(root, "app"), launcher: join(root, "app/bin/placekeeper") });
    expect(rendered).toEqual(entry(root));
    expect(await registerClaudeDesktopServer({ installationId: "a".repeat(64), receiptPath, configPath, entry: rendered })).toBe("registered");
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written).toEqual({ ...others, mcpServers: { ...others.mcpServers, placekeeper: entry(root) } });
    if (process.platform !== "win32") expect((await stat(configPath)).mode & 0o777).toBe(0o644);
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({ schemaVersion: 1, host: "claude-desktop", configPath });
    expect((await readdir(join(root, "Claude"))).sort()).toEqual(["claude_desktop_config.json"]);
  });
  it("reports current without rewriting, even after Claude reformats the file", async () => {
    const { root, configPath, receiptPath } = await fixture(JSON.stringify(others));
    const { registerClaudeDesktopServer } = await import("./integration-registration.js");
    const options = { installationId: "a".repeat(64), receiptPath, configPath, entry: entry(root) };
    await registerClaudeDesktopServer(options);
    const reformatted = JSON.parse(await readFile(configPath, "utf8")); reformatted.mcpServers.placekeeper = { env: entry(root).env, args: entry(root).args, command: entry(root).command };
    await writeFile(configPath, JSON.stringify(reformatted)); const before = await readFile(configPath, "utf8");
    expect(await registerClaudeDesktopServer(options)).toBe("current");
    expect(await readFile(configPath, "utf8")).toBe(before);
  });
  it("repairs its own entry after the app moves and keeps later user additions", async () => {
    const { root, configPath, receiptPath } = await fixture(JSON.stringify(others));
    const { registerClaudeDesktopServer } = await import("./integration-registration.js");
    await registerClaudeDesktopServer({ installationId: "a".repeat(64), receiptPath, configPath, entry: entry(root) });
    const edited = JSON.parse(await readFile(configPath, "utf8")); edited.mcpServers.github = { command: "gh-mcp" }; await writeFile(configPath, JSON.stringify(edited));
    const moved = entry(join(root, "moved"));
    expect(await registerClaudeDesktopServer({ installationId: "b".repeat(64), receiptPath, configPath, entry: moved })).toBe("repaired");
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.mcpServers).toEqual({ filesystem: others.mcpServers.filesystem, placekeeper: moved, github: { command: "gh-mcp" } });
    expect(written.theme).toBe("dark");
    expect(await registerClaudeDesktopServer({ installationId: "b".repeat(64), receiptPath, configPath, entry: moved })).toBe("current");
  });
  it("preserves a foreign or user-edited placekeeper entry", async () => {
    const foreign = { ...others, mcpServers: { ...others.mcpServers, placekeeper: { command: "/custom/placekeeper" } } };
    const { root, configPath, receiptPath } = await fixture(JSON.stringify(foreign, null, 4));
    const { registerClaudeDesktopServer } = await import("./integration-registration.js");
    const before = await readFile(configPath, "utf8");
    await expect(registerClaudeDesktopServer({ installationId: "a".repeat(64), receiptPath, configPath, entry: entry(root) })).rejects.toThrow("Registration changed; existing files were preserved");
    expect(await readFile(configPath, "utf8")).toBe(before);
    await expect(readFile(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    const owned = await fixture(JSON.stringify(others));
    await registerClaudeDesktopServer({ installationId: "a".repeat(64), receiptPath: owned.receiptPath, configPath: owned.configPath, entry: entry(owned.root) });
    const edited = JSON.parse(await readFile(owned.configPath, "utf8")); edited.mcpServers.placekeeper.env.EXTRA = "1"; await writeFile(owned.configPath, JSON.stringify(edited));
    await expect(registerClaudeDesktopServer({ installationId: "b".repeat(64), receiptPath: owned.receiptPath, configPath: owned.configPath, entry: entry(join(owned.root, "moved")) })).rejects.toThrow("changed");
    expect(JSON.parse(await readFile(owned.configPath, "utf8")).mcpServers.placekeeper.env.EXTRA).toBe("1");
  });
  it("leaves malformed or non-object configuration untouched", async () => {
    const { registerClaudeDesktopServer } = await import("./integration-registration.js");
    for (const content of ['{"mcpServers": {', "[]", '{"mcpServers": []}', ""]) {
      const { root, configPath, receiptPath } = await fixture(content);
      await expect(registerClaudeDesktopServer({ installationId: "a".repeat(64), receiptPath, configPath, entry: entry(root) })).rejects.toThrow("left unchanged");
      expect(await readFile(configPath, "utf8")).toBe(content);
      expect(await readdir(join(root, "Claude"))).toEqual(["claude_desktop_config.json"]);
    }
  });
  it("creates the file only inside an existing Claude folder", async () => {
    const { registerClaudeDesktopServer } = await import("./integration-registration.js");
    const { root, configPath, receiptPath } = await fixture();
    expect(await registerClaudeDesktopServer({ installationId: "a".repeat(64), receiptPath, configPath, entry: entry(root) })).toBe("registered");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ mcpServers: { placekeeper: entry(root) } });
    const absent = join(root, "Missing/claude_desktop_config.json");
    await expect(registerClaudeDesktopServer({ installationId: "a".repeat(64), receiptPath: join(root, "other.receipt.json"), configPath: absent, entry: entry(root) })).rejects.toThrow("not found");
    await expect(stat(join(root, "Missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("finishes its own interrupted write recorded as pending", async () => {
    const { root, configPath, receiptPath } = await fixture(JSON.stringify(others));
    const { registerClaudeDesktopServer } = await import("./integration-registration.js");
    await registerClaudeDesktopServer({ installationId: "a".repeat(64), receiptPath, configPath, entry: entry(root) });
    const moved = entry(join(root, "moved"));
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    const config = JSON.parse(await readFile(configPath, "utf8")); config.mcpServers.placekeeper = moved; await writeFile(configPath, JSON.stringify(config));
    const { createHash } = await import("node:crypto");
    const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);
    await writeFile(receiptPath, JSON.stringify({ ...receipt, pendingSha256: createHash("sha256").update(canonical(moved)).digest("hex") }));
    expect(await registerClaudeDesktopServer({ installationId: "a".repeat(64), receiptPath, configPath, entry: moved })).toBe("current");
    expect(JSON.parse(await readFile(receiptPath, "utf8")).pendingSha256).toBeUndefined();
  });
});
