import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ciUnitFiles, suiteCommand, suites } from "./suites.js";

// Exercise the real shell boundary with inert executables. These tests do not
// build fixtures or start browsers, and their expected outcomes are independent
// of the registry's implementation.
async function withRunners(run: (directory: string, env: NodeJS.ProcessEnv) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "placekeeper-suite-"));
  const log = join(directory, "calls.jsonl");
  const stub = `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(process.env.SUITE_LOG, JSON.stringify({command: require('node:path').basename(process.argv[1]), args:process.argv.slice(2)})+'\\n');\nif(process.env.SUITE_SIGNAL)process.kill(process.pid,process.env.SUITE_SIGNAL);\nif(process.argv[2] === 'fixtures:pdf')process.exit(Number(process.env.SUITE_FIXTURE_EXIT || 0));\n`;
  try {
    for (const name of ["pnpm", "vitest", "playwright"]) {
      await writeFile(join(directory, name), stub, { mode: 0o755 });
    }
    await run(directory, { ...process.env, PATH: `${directory}:${process.env.PATH}`, SUITE_LOG: log });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const runner = resolve("scripts/testing/run-suite.ts");
const invoke = (suite: string, env: NodeJS.ProcessEnv, args: string[] = []) =>
  spawnSync(process.execPath, ["--import", "tsx", runner, suite, ...args], { env, encoding: "utf8" });

describe("explicit suite contracts", () => {
  it("retains milestone aliases and the standalone VS Code freshness prerequisite", async () => {
    const { scripts } = JSON.parse(await readFile("package.json", "utf8"));
    for (const [old, name] of Object.entries({
      "test:u4": "test:review", "test:u5": "test:save-export",
      "test:u6": "test:source-rebuild", "test:u7-host": "test:host-integration",
      "test:u7": "test:production-integration", "test:u8": "test:full-validation",
    })) {
      expect(scripts[old]).toBe(`pnpm ${name}`);
      expect(scripts[name]).toBe(`node --import tsx scripts/testing/run-suite.ts ${name}`);
      expect(suites[name]).toBeDefined();
    }
    const vscode = JSON.parse(await readFile("apps/vscode/package.json", "utf8"));
    expect(vscode.scripts.build).toBe("pnpm --dir ../.. build:web && pnpm build:bundle");
    expect(suites["test:ci:unit"]?.[0]).toBe("pnpm build:vscode");
    expect(ciUnitFiles).toContain("packaging/macos/update-vscode.test.mjs");
  });

  it("keeps WebKit's intentional omissions and repeated fixture stages", () => {
    expect(suites["test:e2e"]?.[0]).toBe("pnpm build:vscode");
    expect(suites["test:e2e:webkit"]?.[0]).toBe("pnpm build:vscode");
    expect(suiteCommand("test:e2e")).toContain("neutral-design-conformance.spec.ts");
    expect(suiteCommand("test:e2e:webkit")).not.toContain("neutral-design-conformance.spec.ts");
    expect(suiteCommand("test:e2e:webkit")).not.toContain("host-interface.spec.ts");
    expect(suites["test:pdf-conformance"]).toEqual([
      "pnpm fixtures:pdf", "pnpm test:pdf-writer", "pnpm test:reviewed-pdf", "pnpm test:pdf-viewer",
    ]);
    expect(suites["test:reviewed-pdf"]?.[0]).toBe("pnpm fixtures:pdf");
  });

  it("keeps the cross-host refresh and recovery matrix in host integration", () => {
    const command = suiteCommand("test:host-integration");
    for (const file of [
      "apps/service/test/codex-live-context.integration.test.ts",
      "apps/service/test/live-source-workflow.test.ts",
      "apps/service/test/live-document-replacement.test.ts",
      "apps/service/test/recovery.test.ts",
      "apps/web/test/host-runtime.test.ts",
    ]) expect(command).toContain(file);
  });

  it("keeps automatic PDF refresh regressions in canonical CI", () => {
    for (const file of [
      "apps/service/test/local-document-observer.test.ts",
      "apps/web/test/refresh-interaction-lifecycle.test.tsx",
      "packaging/macos/native-blob-install.test.ts",
    ]) expect(ciUnitFiles).toContain(file);

    expect(suiteCommand("test:ci:chromium")).toContain(
      "test/acceptance/automatic-pdf-refresh.spec.ts",
    );
  });

  it("keeps authoring lifecycle regressions in named and canonical gates", () => {
    const unit = "apps/web/test/use-authoring-session-lifecycle.test.ts";
    expect(suiteCommand("test:review")).toContain(unit);
    expect(ciUnitFiles).toContain(unit);
    const reconnect = "apps/web/test/interaction-reconnect-runtime.test.ts";
    expect(suiteCommand("test:review")).toContain(reconnect);
    expect(ciUnitFiles).toContain(reconnect);

    const browser = "test/acceptance/authoring-lifecycle-regressions.spec.ts";
    for (const suite of [
      "test:e2e",
      "test:e2e:webkit",
      "test:ci:chromium",
      "test:ci:webkit",
    ]) expect(suiteCommand(suite)).toContain(browser);
  });

  it.skipIf(process.platform === "win32")("stops on prerequisite failure with the original exit result", async () => {
    await withRunners(async (directory, env) => {
      const result = invoke("test:web", { ...env, SUITE_FIXTURE_EXIT: "27" });
      expect(result.status, result.stderr).toBe(27);
      const calls = (await readFile(join(directory, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(calls).toEqual([{ command: "pnpm", args: ["fixtures:pdf"] }]);
    });
  });

  it.skipIf(process.platform === "win32")("forwards literal filters only to the final stage, preserving stage order", async () => {
    await withRunners(async (directory, env) => {
      const args = ["--grep", "a b; $(echo unsafe) 'quoted'"];
      const result = invoke("test:web", env, args);
      expect(result.status, result.stderr).toBe(0);
      const calls = (await readFile(join(directory, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(calls.map(call => call.command)).toEqual(["pnpm", "vitest", "playwright"]);
      expect(calls[0].args).toEqual(["fixtures:pdf"]);
      expect(calls[1].args).not.toContain("--grep");
      expect(calls[2].args).toEqual(["test", "--config", "scripts/testing/config/playwright.config.ts", "test/acceptance/viewer.spec.ts", ...args]);
    });
  });

  it.skipIf(process.platform === "win32")("preserves shell signal exit behavior", async () => {
    await withRunners(async (_directory, env) => {
      const signalEnv = { ...env, SUITE_SIGNAL: "SIGTERM" };
      const baseline = spawnSync("/bin/sh", ["-c", "vitest run apps/service/test/session-security.test.ts apps/service/test/recovery.test.ts apps/service/test/export-transaction.test.ts apps/service/test/replace-original.test.ts"], { env: signalEnv });
      const actual = invoke("test:security", signalEnv);
      expect({ status: actual.status, signal: actual.signal }).toEqual({ status: baseline.status, signal: baseline.signal });
    });
  });
});
