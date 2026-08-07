import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test("Finder Quick Action passes exactly one explicit path to the shared launcher", async () => {
  const workflow = await readFile(resolve("integrations/finder/PdfProofreader.workflow/Contents/document.wflow"), "utf8");
  expect(workflow).toContain("PDF Proofreader.app/Contents/MacOS/pdf-proofreader");
  expect(workflow).toContain("--pdf");
  expect(workflow).toContain("--surface finder");
  expect(workflow).toContain("display alert");
  expect(workflow).toContain("choose file of type");
  expect(workflow).toContain("choose from list");
  expect(workflow).toContain('--recovery "$choice"');
  expect(workflow).toContain('system attribute "PDF_PROOFREADER_URL"');
  expect(workflow).not.toContain('/usr/bin/open "$url"');
  expect(workflow).not.toContain("Terminal.app");
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
