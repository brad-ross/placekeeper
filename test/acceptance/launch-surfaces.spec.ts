import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { validateCodexPlugin } from "../../packaging/macos/validate-manifest.js";

test("Finder Open With passes exactly one explicit path through the native document bridge", async () => {
  const bridge = await readFile(resolve("packaging/macos/finder-bridge.applescript"), "utf8");
  const manifest = JSON.parse(await readFile(resolve("packaging/macos/app-bundle.json"), "utf8")) as { finderExecutable: string; documentTypes: unknown[]; embeddedArtifacts: Record<string, string> };
  expect(manifest.finderExecutable).toBe("droplet");
  expect(manifest.documentTypes).toHaveLength(1);
  expect(manifest.embeddedArtifacts).not.toHaveProperty("finderQuickAction");
  expect(bridge).toContain("on open pdfItems");
  expect(bridge).toContain("(count of pdfItems) is not 1");
  expect(bridge).toContain("Contents/MacOS/placekeeper");
  expect(bridge).toContain("quoted form of pdfPath");
  expect(bridge).toContain("choose file of type");
  expect(bridge).not.toContain("Terminal.app");
});

test("Codex plugin packages launch plus task-scoped live-context hooks", async () => {
  const pluginRoot = resolve("integrations/codex-plugin");
  await expect(validateCodexPlugin(pluginRoot)).resolves.toBeUndefined();
  const marketplace = JSON.parse(await readFile(resolve(".agents/plugins/marketplace.json"), "utf8")) as {
    name: string;
    interface: { displayName: string };
    plugins: Array<{
      name: string;
      source: { source: string; path: string };
      policy: { installation: string; authentication: string };
      category: string;
    }>;
  };
  const plugin = JSON.parse(await readFile(resolve("integrations/codex-plugin/.codex-plugin/plugin.json"), "utf8")) as { name: string; skills: string; author: { name: string }; interface: { displayName: string; developerName: string; defaultPrompt: string; composerIcon: string; logo: string; logoDark: string; longDescription: string } };
  expect(marketplace).toMatchObject({
    name: "placekeeper-local",
    interface: { displayName: "Placekeeper Local" },
    plugins: [{
      name: "codex-plugin",
      source: { source: "local", path: "./integrations/codex-plugin" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  });
  expect(plugin).toMatchObject({
    name: "codex-plugin",
    skills: "./skills/",
    author: { name: "Placekeeper" },
    interface: {
      displayName: "Placekeeper",
      developerName: "Placekeeper",
      defaultPrompt: "Open this local PDF in Placekeeper with $placekeeper.",
      composerIcon: "./assets/placekeeper.svg",
      logo: "./assets/placekeeper.svg",
      logoDark: "./assets/placekeeper.svg",
    },
  });
  expect(plugin.interface.longDescription).toContain("every prompt");
});

test("VS Code manifest is desktop-local and exposes one PDF command", async () => {
  const manifest = JSON.parse(await readFile(resolve("apps/vscode/package.json"), "utf8")) as { name: string; displayName: string; publisher: string; icon: string; extensionKind: string[]; browser?: string; contributes: { commands: Array<{ command: string; title: string; icon: { light: string; dark: string } }>; configuration: { properties: Record<string, unknown> } } };
  expect(manifest.name).toBe("placekeeper-vscode");
  expect(manifest.displayName).toBe("Placekeeper");
  expect(manifest.publisher).toBe("placekeeper-local");
  expect(manifest.icon).toBe("assets/placekeeper.png");
  expect(manifest.extensionKind).toEqual(["ui"]);
  expect(manifest.browser).toBeUndefined();
  expect(manifest.contributes.commands).toHaveLength(1);
  expect(manifest.contributes.commands[0]).toEqual({
    command: "placekeeper.open",
    title: "Placekeeper: Open Local PDF",
    icon: {
      light: "assets/placekeeper.svg",
      dark: "assets/placekeeper.svg",
    },
  });
  expect(manifest.contributes.configuration.properties).toHaveProperty(["placekeeper.launcherPath"]);
});

test("VS Code review loads the shared client directly without a localhost frame", async () => {
  const panel = await readFile(resolve("apps/vscode/src/review-panel.ts"), "utf8");
  const extension = await readFile(resolve("apps/vscode/src/extension.ts"), "utf8");
  const productionEntry = await readFile(resolve("apps/web/src/production-entry.tsx"), "utf8");
  expect(panel).toContain("app.startVscode");
  expect(panel).toContain("worker-src blob:");
  expect(panel).toContain("frame-src 'none'");
  expect(panel).not.toContain("<iframe");
  expect(panel).not.toContain("launch-url");
  expect(extension).toContain("exchangeVscodeLaunch(result.url)");
  expect(panel).toContain("localResourceRoots");
  expect(extension).not.toContain("postMessage({ type: \"launch-url\"");
  expect(productionEntry).toContain("export async function startVscode");
});

test("only the Codex adapter requests the Codex launch surface", async () => {
  const finder = await readFile(resolve("packaging/macos/launcher.mjs"), "utf8");
  const vscode = await readFile(resolve("apps/vscode/src/launch-client.ts"), "utf8");
  const skill = await readFile(
    resolve("integrations/codex-plugin/skills/placekeeper/SKILL.md"),
    "utf8",
  );
  expect(finder).toContain('["open", "--json", "--surface", "finder"');
  expect(finder).not.toContain('"--surface", "codex"');
  expect(vscode).toContain('["open", "--json", "--surface", "vscode"');
  expect(vscode).not.toContain('"--surface", "codex"');
  expect(skill).toContain("--surface codex");
  expect(skill).toContain(
    '`"$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper" open-link --json --surface codex --confirmed',
  );
  expect(skill).toContain("rerun the same full installed-launcher command");
  expect(skill).not.toContain("Then run `open-link");
});
