import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";

import { minimalMacosChildEnvironment } from "../../apps/service/src/macos/native-gate.js";

function entitlementKeys(xml: string): string[] {
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml) as {
    plist: { dict: { key?: string | string[] } };
  };
  const key = parsed.plist.dict.key ?? [];
  return Array.isArray(key) ? key : [key];
}

describe("macOS native gate packaging policy", () => {
  it("keeps the proof executable production-shaped and network-free", async () => {
    const [windowSource, appSource, packageSource] = await Promise.all([
      readFile(resolve("apps/macos/Sources/PlacekeeperMac/PlacekeeperWindowController.swift"), "utf8"),
      readFile(resolve("apps/macos/Sources/PlacekeeperMac/PlacekeeperMac.swift"), "utf8"),
      readFile(resolve("apps/macos/Package.swift"), "utf8"),
    ]);
    expect(packageSource).toContain(".macOS(.v13)");
    expect(windowSource).toContain(".fullSizeContentView");
    expect(windowSource).toContain("configuration.websiteDataStore = .nonPersistent()");
    expect(windowSource).toContain('forURLScheme: "placekeeper-app"');
    expect(windowSource).toContain('forURLScheme: "placekeeper-resource"');
    expect(windowSource).toContain("compileContentRuleList");
    expect(windowSource).toContain("callAsyncJavaScript");
    expect(windowSource).not.toMatch(/127\.0\.0\.1|localhost|Loopback Review/iu);
    expect(appSource).toContain('ProcessInfo.processInfo.environment["PLACEKEEPER_MAC_REVIEW_HELPER"]');
    expect(appSource).toContain("applicationShouldTerminateAfterLastWindowClosed");
  });

  it("strips Node and dynamic-loader injection from child environments", () => {
    const environment = minimalMacosChildEnvironment({
      PATH: "/usr/bin:/bin",
      TMPDIR: "/private/tmp",
      HOME: "/Users/reviewer",
      LANG: "en_US.UTF-8",
      NODE_OPTIONS: "--require=/tmp/inject.js",
      NODE_PATH: "/tmp/modules",
      DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
      LD_PRELOAD: "/tmp/inject.so",
      PLACEKEEPER_RUNTIME_ROOT: "/Applications/Placekeeper.app/Contents/Resources",
      PLACEKEEPER_APP_INSTANCE_ID: "app_12345678",
      PLACEKEEPER_HELPER_ID: "helper_12345678",
      UNRELATED_SECRET: "no",
    });
    expect(environment).toEqual({
      PATH: "/usr/bin:/bin",
      TMPDIR: "/private/tmp",
      HOME: "/Users/reviewer",
      LANG: "en_US.UTF-8",
      PLACEKEEPER_RUNTIME_ROOT: "/Applications/Placekeeper.app/Contents/Resources",
      PLACEKEEPER_APP_INSTANCE_ID: "app_12345678",
      PLACEKEEPER_HELPER_ID: "helper_12345678",
    });
  });

  it("pins representative app and Node helper entitlement allowlists", async () => {
    const [app, node] = await Promise.all([
      readFile(resolve("packaging/macos/entitlements-app.plist"), "utf8"),
      readFile(resolve("packaging/macos/entitlements-node.plist"), "utf8"),
    ]);
    expect(entitlementKeys(app).sort()).toEqual([]);
    expect(entitlementKeys(node).sort()).toEqual([
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.network.client",
      "com.apple.security.network.server",
    ]);
  });

  it("pins an ordinary and adversarial qualification corpus with cleanup budgets", async () => {
    const budget = JSON.parse(await readFile(
      resolve("test/acceptance/macos-qualification-budget.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(budget).toMatchObject({
      schemaVersion: 1,
      minimumSystemVersion: "13.0",
      fixtures: {
        ordinary: { path: "test/fixtures/pdfs/text-native.pdf" },
        adversarial: { path: "test/fixtures/pdfs/hostile-actions.pdf" },
      },
      cleanup: { helperExitMs: 2_000, ownershipBaselineMs: 2_000 },
    });
    const fixtures = budget.fixtures as Record<string, { path: string; sha256: string; bytes: number }>;
    for (const fixture of Object.values(fixtures)) {
      const bytes = await readFile(resolve(fixture.path));
      expect(bytes.byteLength).toBe(fixture.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixture.sha256);
    }
    const evidence = budget.evidenceRequired as string[];
    expect(evidence).toContain("visibleShellReady");
    expect(evidence).toContain("cleanupCounters");
    expect(evidence.join("\0")).not.toMatch(/path|filename|credential|task|capability|token/iu);
  });
});
