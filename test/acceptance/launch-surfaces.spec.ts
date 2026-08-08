import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

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

test("Codex plugin contains one validated launch-only skill", async () => {
  const plugin = JSON.parse(await readFile(resolve("integrations/codex-plugin/.codex-plugin/plugin.json"), "utf8")) as { name: string; skills: string };
  const skill = await readFile(resolve("integrations/codex-plugin/skills/pdf-proofreader/SKILL.md"), "utf8");
  expect(plugin).toMatchObject({ name: "codex-plugin", skills: "./skills/" });
  expect(skill).toContain("pdf-proofreader open --json --surface codex --pdf");
  expect(skill).toContain("desktop built-in browser");
  expect(skill).toContain("Do not submit");
  expect(skill).not.toContain("[TODO:");
});

test("VS Code manifest is desktop-local and exposes one PDF command", async () => {
  const manifest = JSON.parse(await readFile(resolve("apps/vscode/package.json"), "utf8")) as { extensionKind: string[]; browser?: string; contributes: { commands: unknown[] } };
  expect(manifest.extensionKind).toEqual(["ui"]);
  expect(manifest.browser).toBeUndefined();
  expect(manifest.contributes.commands).toHaveLength(1);
});
