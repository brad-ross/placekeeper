import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG_DISTRIBUTION_BASELINE, validateCatalogSourceBaseline, validateCatalogRuntimeDistribution, validateCatalogThirdPartyNotices, validateMacIconMaster, validateMacIconSet, validateCodexPlugin, validateSharedWebDistribution } from "./validate-distribution.js";

describe("shared distribution contracts", () => {
  it("pins reviewed catalog counts, indexes, and deterministic artifact bytes", async () => {
    await expect(validateCatalogSourceBaseline(resolve("."))).resolves.toBeUndefined();
    expect(CATALOG_DISTRIBUTION_BASELINE).toMatchObject({
      records: 3_060,
      indexCardinalities: {
        glyph: 3_060,
        command: 2_795,
        entity: 1_975,
        normalizedName: 4_724,
      },
      artifactBytes: {
        runtime: 406_546,
        report: 7_361,
      },
      artifactSha256: {
        runtime: "423428687dab0b6049a86d85f879df79f2fee251322d53ad314ae1effd616e3b",
        report: "84bda58674d8174a0a94bbaed846ce23628cbf62fcab018cef14b182d38db797",
        thirdPartyNotices: "469845e0081b04e67f86db343a8a69f52e8488cdcd2b5da7708aec78a8647104",
      },
      productionWebJavaScriptBytes: 3_200_000,
    });

    const root = await mkdtemp(resolve(tmpdir(), "placekeeper-catalog-baseline-"));
    try {
      const generated = resolve(root, "scripts/pdf-symbol-catalog/generated");
      const runtime = resolve(root, "apps/web/src/pdf");
      await mkdir(generated, { recursive: true });
      await mkdir(runtime, { recursive: true });
      await copyFile(resolve("scripts/pdf-symbol-catalog/generated/update-report.json"), resolve(generated, "update-report.json"));
      await copyFile(resolve("apps/web/src/pdf/pdf-symbol-catalog.generated.ts"), resolve(runtime, "pdf-symbol-catalog.generated.ts"));
      await writeFile(resolve(runtime, "pdf-symbol-catalog.generated.ts"), "reviewed baseline regression\n");
      await expect(validateCatalogSourceBaseline(root)).rejects.toThrow(/baseline changed/u);
      await copyFile(resolve("apps/web/src/pdf/pdf-symbol-catalog.generated.ts"), resolve(runtime, "pdf-symbol-catalog.generated.ts"));
      const reportPath = resolve(generated, "update-report.json");
      const report = await readFile(reportPath, "utf8");
      const tamperedReport = report.replace(
        /("catalogSha256": ")([0-9a-f])/u,
        (_match, prefix: string, digit: string) => `${prefix}${digit === "0" ? "1" : "0"}`,
      );
      expect(Buffer.byteLength(tamperedReport)).toBe(Buffer.byteLength(report));
      await writeFile(reportPath, tamperedReport);
      await expect(validateCatalogSourceBaseline(root)).rejects.toThrow(/digest baseline changed/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ships only compact catalog behavior and confines attribution URLs to the notice", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "placekeeper-catalog-runtime-"));
    const runtime = resolve(root, "Resources");
    const web = resolve(runtime, "web");
    const notice = resolve(runtime, "THIRD_PARTY_NOTICES.md");
    try {
      await mkdir(web, { recursive: true });
      await copyFile(resolve("THIRD_PARTY_NOTICES.md"), notice);
      const compact = 'const catalog = "⏐ vertical line extension";\n';
      await writeFile(resolve(web, "app.js"), compact);
      await expect(validateCatalogRuntimeDistribution({
        runtimeRoot: runtime,
        webEntry: resolve(web, "app.js"),
        noticePath: notice,
      })).resolves.toBeUndefined();

      await writeFile(resolve(web, "source-manifest.json"), "{}\n");
      await expect(validateCatalogRuntimeDistribution({
        runtimeRoot: runtime,
        webEntry: resolve(web, "app.js"),
        noticePath: notice,
      })).rejects.toThrow(/must not ship/u);
      await rm(resolve(web, "source-manifest.json"));

      await writeFile(resolve(web, "app.js"), `${compact}const source = "https://www.unicode.org/Public/17.0.0/ucd/";\n`);
      await expect(validateCatalogRuntimeDistribution({
        runtimeRoot: runtime,
        webEntry: resolve(web, "app.js"),
        noticePath: notice,
      })).rejects.toThrow(/leaked into runtime asset/u);

      await writeFile(
        resolve(web, "app.js"),
        Buffer.concat([
          Buffer.from(compact),
          Buffer.alloc(CATALOG_DISTRIBUTION_BASELINE.productionWebJavaScriptBytes, 0x78),
        ]),
      );
      await expect(validateCatalogRuntimeDistribution({
        runtimeRoot: runtime,
        webEntry: resolve(web, "app.js"),
        noticePath: notice,
      })).rejects.toThrow(/bundle baseline/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects incomplete, misnamed, nonsquare, and wrongly sized icon representations", async () => {
    const source = resolve("packaging/macos/icon/Placekeeper.iconset");

    const withIconset = async (mutate: (iconset: string) => Promise<void>): Promise<string> => {
      const root = await mkdtemp(resolve(tmpdir(), "placekeeper-iconset-test-"));
      const iconset = resolve(root, "Placekeeper.iconset");
      await cp(source, iconset, { recursive: true });
      await mutate(iconset);
      return root;
    };

    const missingRoot = await withIconset(async (iconset) => {
      await rm(resolve(iconset, "icon_16x16.png"));
    });
    const misnamedRoot = await withIconset(async (iconset) => {
      await rename(resolve(iconset, "icon_16x16.png"), resolve(iconset, "icon_16.png"));
    });
    const wrongSizeRoot = await withIconset(async (iconset) => {
      await writeFile(resolve(iconset, "icon_16x16.png"), await readFile(resolve(iconset, "icon_16x16@2x.png")));
    });
    const nonsquareRoot = await withIconset(async (iconset) => {
      const path = resolve(iconset, "icon_16x16.png");
      const png = await readFile(path);
      png.writeUInt32BE(15, 20);
      await writeFile(path, png);
    });

    try {
      await expect(validateMacIconSet(resolve(missingRoot, "Placekeeper.iconset"))).rejects.toThrow(/filenames/u);
      await expect(validateMacIconSet(resolve(misnamedRoot, "Placekeeper.iconset"))).rejects.toThrow(/filenames/u);
      await expect(validateMacIconSet(resolve(wrongSizeRoot, "Placekeeper.iconset"))).rejects.toThrow(/dimensions/u);
      await expect(validateMacIconSet(resolve(nonsquareRoot, "Placekeeper.iconset"))).rejects.toThrow(/square/u);
    } finally {
      await Promise.all([missingRoot, misnamedRoot, wrongSizeRoot, nonsquareRoot].map(async (root) => await rm(root, { recursive: true, force: true })));
    }
  });

  it("rejects missing, duplicate, external, and stale shared-client assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-web-manifest-"));
    try {
      await cp(resolve("dist/web"), root, { recursive: true });
      await rm(join(root, "pdfium.wasm"));
      await expect(validateSharedWebDistribution(root)).rejects.toThrow(/missing|pdfium/iu);

      await rm(root, { recursive: true, force: true });
      await cp(resolve("dist/web"), root, { recursive: true });
      const manifestPath = join(root, "asset-manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      await writeFile(manifestPath, JSON.stringify({ ...manifest, stylesheet: manifest.app }));
      await expect(validateSharedWebDistribution(root)).rejects.toThrow(/duplicate/iu);

      await writeFile(manifestPath, JSON.stringify({ ...manifest, app: "https://example.invalid/app.js" }));
      await expect(validateSharedWebDistribution(root)).rejects.toThrow(/local|asset|manifest/iu);

      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(join(root, "stale.js"), "stale");
      await expect(validateSharedWebDistribution(root)).rejects.toThrow(/stale|unexpected/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects every missing or corrupt integrity-pinned shared-client asset", async () => {
    const source = resolve("dist/web");
    const manifest = await validateSharedWebDistribution(source);
    for (const asset of [
      "asset-manifest.json",
      manifest.app,
      manifest.stylesheet,
      manifest.pdfiumWasm,
      manifest.pdfiumWorker,
      manifest.pdfiumCodexWorker,
    ]) {
      const root = await mkdtemp(join(tmpdir(), "placekeeper-shared-asset-"));
      try {
        await cp(source, root, { recursive: true });
        await rm(join(root, asset));
        await expect(validateSharedWebDistribution(root)).rejects.toThrow(new RegExp(asset.replace(".", "\\."), "u"));

        await rm(root, { recursive: true, force: true });
        await cp(source, root, { recursive: true });
        await writeFile(join(root, asset), "corrupt");
        await expect(validateSharedWebDistribution(root)).rejects.toThrow(new RegExp(asset.replace(".", "\\."), "u"));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("validates both canonical Codex PostToolUse declarations", async () => {
    const config = JSON.parse(await readFile(resolve("integrations/codex-plugin/hooks/hooks.json"), "utf8"));
    expect(config.hooks.PostToolUse[0].hooks[0].timeout).toBe(8);
    expect(config.hooks.PostToolUse[1].hooks[0].timeout).toBe(55);
    expect(config.hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(8);
    expect(config.hooks.SessionEnd[0].hooks[0].timeout).toBe(3);
    await expect(validateCodexPlugin(resolve("integrations/codex-plugin"))).resolves.toBeUndefined();
  });

  it.each([
    "missing-launcher", "missing-display", "extra-declaration", "duplicate-display",
    "malformed-display", "wrong-display-matcher", "wrong-launcher-matcher",
    "wrong-display-command", "wrong-display-timeout", "old-display-timeout", "wrong-display-context-limit",
    "wrong-display-status", "extra-display-handler",
  ])("rejects the %s Codex hook contract", async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-hook-contract-"));
    const pluginRoot = join(root, "codex-plugin");
    try {
      await cp(resolve("integrations/codex-plugin"), pluginRoot, { recursive: true });
      const path = join(pluginRoot, "hooks/hooks.json");
      const manifest = JSON.parse(await readFile(path, "utf8")) as {
        hooks: { PostToolUse: Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }> };
      };
      const declarations = manifest.hooks.PostToolUse;
      const display = declarations[1]!;
      const handler = display.hooks[0]!;
      switch (failure) {
        case "missing-launcher": declarations.splice(0, 1); break;
        case "missing-display": declarations.splice(1, 1); break;
        case "extra-declaration": declarations.push(structuredClone(display)); break;
        case "duplicate-display": declarations[0] = structuredClone(display); break;
        case "malformed-display": declarations[1] = null as unknown as typeof display; break;
        case "wrong-display-matcher": display.matcher = "^mcp__.*__display_review$"; break;
        case "wrong-launcher-matcher": declarations[0]!.matcher = "Bash"; break;
        case "wrong-display-command": handler.command = "placekeeper hook --event"; break;
        case "wrong-display-timeout": handler.timeout = 5; break;
        case "old-display-timeout": handler.timeout = 8; break;
        case "wrong-display-context-limit": handler.additionalContextLimit = 256; break;
        case "wrong-display-status": handler.statusMessage = "Connecting Placekeeper context"; break;
        case "extra-display-handler": display.hooks.push(structuredClone(handler)); break;
      }
      await writeFile(path, JSON.stringify(manifest));
      await expect(validateCodexPlugin(pluginRoot)).rejects.toThrow(/PostToolUse/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["remote", "wrong-entry", "extra-server", "missing-entry", "foreign-runtime", "foreign-launcher"])("rejects %s native MCP packaging", async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "pk-mcp-package-"));
    const pluginRoot = join(root, "codex-plugin");
    try {
      await cp(resolve("integrations/codex-plugin"), pluginRoot, { recursive: true });
      const file = join(pluginRoot, ".mcp.json");
      const mcp = JSON.parse(await readFile(file, "utf8"));
      if (failure === "remote") mcp.mcpServers.placekeeper = { url: "https://example.invalid" };
      if (failure === "wrong-entry") mcp.mcpServers.placekeeper.args = ["/tmp/untrusted.sh"];
      if (failure === "extra-server") mcp.mcpServers.other = { command: "/bin/sh" };
      if (failure === "missing-entry") await rm(join(pluginRoot, "scripts/mcp.sh"));
      if (failure === "foreign-runtime" || failure === "foreign-launcher") {
        const scriptPath = join(pluginRoot, "scripts/mcp.sh");
        const script = await readFile(scriptPath, "utf8");
        await writeFile(scriptPath, script.replace(
          failure === "foreign-runtime" ? 'node="$resources/node/bin/node"' : 'PLACEKEEPER_LAUNCHER="$resources/bin/placekeeper"',
          failure === "foreign-runtime" ? 'node="/usr/local/bin/node"' : 'PLACEKEEPER_LAUNCHER="/other-app/bin/placekeeper"',
        ));
      }
      await writeFile(file, JSON.stringify(mcp));
      await expect(validateCodexPlugin(pluginRoot)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a missing or operationally incomplete Codex skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-plugin-contract-"));
    const pluginRoot = join(root, "codex-plugin");
    try {
      await cp(resolve("integrations/codex-plugin"), pluginRoot, { recursive: true });
      await expect(validateCodexPlugin(pluginRoot)).resolves.toBeUndefined();

      await rm(join(pluginRoot, "skills/placekeeper/SKILL.md"));
      await expect(validateCodexPlugin(pluginRoot)).rejects.toThrow(/placekeeper.*required|required.*placekeeper/ui);

      await cp(resolve("integrations/codex-plugin"), pluginRoot, { recursive: true, force: true });
      const sourcePath = join(pluginRoot, "skills/placekeeper/references/source-work.md");
      const source = await readFile(sourcePath, "utf8");
      await writeFile(sourcePath, source.replace("A failed refresh blocks completion.", "A failed refresh may be ignored."));
      await expect(validateCodexPlugin(pluginRoot)).rejects.toThrow(/omitted required contract text/ui);

      await cp(resolve("integrations/codex-plugin"), pluginRoot, { recursive: true, force: true });
      await rm(join(pluginRoot, "skills/placekeeper/references/live-evidence.md"));
      await expect(validateCodexPlugin(pluginRoot)).rejects.toThrow(/ENOENT/u);

      await cp(resolve("integrations/codex-plugin"), pluginRoot, { recursive: true, force: true });
      const skillPath = join(pluginRoot, "skills/placekeeper/SKILL.md");
      const skill = await readFile(skillPath, "utf8");
      await writeFile(skillPath, skill.replace("](references/source-work.md)", "](references/missing.md)"));
      await expect(validateCodexPlugin(pluginRoot)).rejects.toThrow(/must link references/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
