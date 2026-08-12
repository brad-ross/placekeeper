import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { CODEX_INSTALLED_LAUNCHER_COMMAND } from "../../apps/service/src/cli/hook-command.js";

test("Finder Open With passes exactly one explicit path through the native document bridge", async () => {
  const bridge = await readFile(resolve("packaging/macos/finder-bridge.applescript"), "utf8");
  const manifest = JSON.parse(await readFile(resolve("packaging/macos/app-bundle.json"), "utf8")) as { finderExecutable: string; documentTypes: unknown[]; embeddedArtifacts: Record<string, string> };
  expect(manifest.finderExecutable).toBe("droplet");
  expect(manifest.documentTypes).toHaveLength(1);
  expect(manifest.embeddedArtifacts).not.toHaveProperty("finderQuickAction");
  expect(bridge).toContain("on open pdfItems");
  expect(bridge).toContain("(count of pdfItems) is not 1");
  expect(bridge).toContain("Contents/MacOS/pdf-proofreader");
  expect(bridge).toContain("quoted form of pdfPath");
  expect(bridge).toContain("choose file of type");
  expect(bridge).not.toContain("Terminal.app");
});

test("Codex plugin packages launch plus task-scoped live-context hooks", async () => {
  const plugin = JSON.parse(await readFile(resolve("integrations/codex-plugin/.codex-plugin/plugin.json"), "utf8")) as { name: string; skills: string; interface: { longDescription: string } };
  const hooks = JSON.parse(await readFile(resolve("integrations/codex-plugin/hooks/hooks.json"), "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>> };
  const skill = await readFile(resolve("integrations/codex-plugin/skills/pdf-proofreader/SKILL.md"), "utf8");
  expect(plugin).toMatchObject({ name: "codex-plugin", skills: "./skills/" });
  expect(plugin.interface.longDescription).toContain("every prompt");
  expect(Object.keys(hooks.hooks).sort()).toEqual(["PostToolUse", "SessionEnd", "UserPromptSubmit"]);
  for (const declarations of Object.values(hooks.hooks)) {
    expect(declarations[0]?.hooks[0]?.command).toBe(`${CODEX_INSTALLED_LAUNCHER_COMMAND} hook --event`);
  }
  expect(hooks.hooks.PostToolUse?.[0]?.hooks[0]?.timeout).toBeGreaterThan(5);
  expect(hooks.hooks.UserPromptSubmit?.[0]?.hooks[0]?.timeout).toBeGreaterThan(5);
  expect(hooks.hooks.SessionEnd?.[0]?.hooks[0]?.timeout).toBe(3);
  expect(skill).toContain(`${CODEX_INSTALLED_LAUNCHER_COMMAND} open --json --surface codex --pdf`);
  expect(skill).toContain("desktop built-in browser");
  expect(skill).toContain("pdf-proofreader-live-context");
  expect(skill).toContain("context evidence --handle");
  expect(skill).toContain("Do not submit");
  expect(skill).not.toContain("[TODO:");
});

test("VS Code manifest is desktop-local and exposes one PDF command", async () => {
  const manifest = JSON.parse(await readFile(resolve("apps/vscode/package.json"), "utf8")) as { extensionKind: string[]; browser?: string; contributes: { commands: unknown[] } };
  expect(manifest.extensionKind).toEqual(["ui"]);
  expect(manifest.browser).toBeUndefined();
  expect(manifest.contributes.commands).toHaveLength(1);
});

test("only the Codex adapter requests the Codex launch surface", async () => {
  const finder = await readFile(resolve("packaging/macos/launcher.mjs"), "utf8");
  const vscode = await readFile(resolve("apps/vscode/src/launch-client.ts"), "utf8");
  const skill = await readFile(resolve("integrations/codex-plugin/skills/pdf-proofreader/SKILL.md"), "utf8");
  expect(finder).toContain('["open", "--json", "--surface", "finder"');
  expect(finder).not.toContain('"--surface", "codex"');
  expect(vscode).toContain('["open", "--json", "--surface", "vscode"');
  expect(vscode).not.toContain('"--surface", "codex"');
  expect(skill).toContain("--surface codex");
});
