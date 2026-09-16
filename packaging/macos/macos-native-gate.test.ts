import { readCssSource } from '../../test/support/read-css-source.js';
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
  it("keeps the Swift page/helper vocabulary aligned with refresh lifecycle methods", async () => {
    const [bridge, helper] = await Promise.all([
      readFile(resolve("apps/macos/Sources/PlacekeeperMac/ReviewBridge.swift"), "utf8"),
      readFile(resolve("apps/macos/Sources/PlacekeeperMac/ReviewHelper.swift"), "utf8"),
    ]);
    for (const method of [
      "beginInteraction", "finalizeInteraction", "releaseInteraction", "acknowledgeInteraction",
      "resolveReadingLocation",
    ]) {
      expect(bridge).toContain(`"${method}"`);
      expect(helper).toContain(`"${method}"`);
    }
    const nonIdempotent = bridge.slice(bridge.indexOf("private static let nonIdempotent"));
    for (const method of ["beginInteraction", "finalizeInteraction", "releaseInteraction", "acknowledgeInteraction"]) {
      expect(nonIdempotent).toContain(`"${method}"`);
    }
  });

  it("keeps the proof executable production-shaped and network-free", async () => {
    const [windowSource, appSource, packageSource, shellHtml, shellCss, launchSource, registrySource, lifecycleSource, restorationSource, menuSource, fallbackSource] = await Promise.all([
      readFile(resolve("apps/macos/Sources/PlacekeeperMac/PlacekeeperWindowController.swift"), "utf8"),
      readFile(resolve("apps/macos/Sources/PlacekeeperMac/PlacekeeperMac.swift"), "utf8"),
      readFile(resolve("apps/macos/Package.swift"), "utf8"),
      readFile(resolve("apps/web/macos.html"), "utf8"),
      readCssSource(resolve("apps/web/src/app/review-layout.css")),
      readFile(resolve("apps/macos/Sources/PlacekeeperMac/LaunchCoordinator.swift"), "utf8"),
      readFile(resolve("apps/macos/Sources/PlacekeeperMac/DocumentWindowRegistry.swift"), "utf8"),
      readFile(resolve("apps/macos/Sources/PlacekeeperMac/AppLifecycleControlClient.swift"), "utf8"),
      readFile(resolve("apps/macos/Sources/PlacekeeperMac/WindowRestoration.swift"), "utf8"),
      readFile(resolve("apps/macos/Sources/PlacekeeperMac/MenuCoordinator.swift"), "utf8"),
      readFile(resolve("apps/macos/Sources/PlacekeeperMac/CatastrophicFallbackViewController.swift"), "utf8"),
    ]);
    expect(packageSource).toContain(".macOS(.v13)");
    expect(windowSource).toContain(".fullSizeContentView");
    expect(windowSource).toContain("configuration.websiteDataStore = .nonPersistent()");
    expect(windowSource).toContain('forURLScheme: "placekeeper-app"');
    expect(windowSource).toContain('forURLScheme: "placekeeper-resource"');
    expect(windowSource).toContain("compileContentRuleList");
    expect(windowSource).toContain("callAsyncJavaScript");
    expect(windowSource).toContain("webView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor)");
    expect(windowSource).toContain("webView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor)");
    expect(windowSource).not.toMatch(/127\.0\.0\.1|localhost|Loopback Review/iu);
    expect(shellHtml).toContain("connect-src blob: placekeeper-resource:");
    expect(shellHtml).toContain("worker-src blob: placekeeper-app:");
    expect(shellHtml).toContain("'wasm-unsafe-eval'");
    expect(shellHtml).not.toMatch(/https?:|wss?:/u);
    expect(shellCss).toMatch(/\.macos-loading-shell\s*\{[\s\S]*height:\s*100%/u);
    expect(appSource).toContain('named: "PLACEKEEPER_MAC_REVIEW_HELPER"');
    expect(appSource).toContain("allowed: allowDevelopmentOverrides");
    expect(appSource).toContain("applicationShouldTerminateAfterLastWindowClosed");
    expect(appSource).toContain("openFiles filenames: [String]");
    expect(appSource).toContain("NSWindow.allowsAutomaticWindowTabbing = false");
    expect(appSource).toContain("noteNewRecentDocumentURL");
    expect(launchSource).toContain("private(set) var inFlightKeys");
    expect(launchSource).toContain('raw.hasPrefix("placekeeper:///")');
    expect(registrySource).toContain("canonicalReviewID");
    expect(registrySource).not.toContain("sourceURL");
    expect(lifecycleSource).toContain("queued.count < 64");
    expect(restorationSource).toContain('Set(record.keys).isSubset(of: ["sourcePath", "frame", "page", "zoom"])');
    expect(restorationSource).not.toMatch(/sessionId|credential|lease|helperId|attemptId/u);
    for (const title of ["Placekeeper", "File", "Edit", "View", "Window", "Help"]) {
      expect(menuSource).toContain(`NSMenu(title: "${title}")`);
    }
    expect(menuSource).toContain("snapshot.focusContext == .editable");
    expect(windowSource).toContain('"snapshotRevision": snapshot.revision');
    expect(fallbackSource).toContain("onRetry()");
    expect(fallbackSource).toContain("onDiagnostics()");
    expect(fallbackSource).toContain("onClose(view.window)");
    expect(fallbackSource).toContain('retryButton.keyEquivalent = "\\r"');
    expect(appSource).toContain('Shell: native-recovery');
    expect(appSource).not.toContain('informativeText = "Path:');
  });

  it("confines native window dragging to the declared titlebar overlays", async () => {
    const windowSource = await readFile(
      resolve("apps/macos/Sources/PlacekeeperMac/PlacekeeperWindowController.swift"),
      "utf8",
    );
    const draggableTitlebar = windowSource.slice(windowSource.indexOf("private final class DraggableTitlebarView"));
    expect(draggableTitlebar).toContain("override var mouseDownCanMoveWindow: Bool { true }");
    expect(draggableTitlebar).toContain('document.activeElement?.blur()');
    expect(draggableTitlebar).toContain("event.clickCount == 2");
    expect(draggableTitlebar).toContain("window?.performZoom(nil)");
    expect(draggableTitlebar).toContain("window?.performDrag(with: event)");
    expect(draggableTitlebar.indexOf("activeElement?.blur")).toBeLessThan(draggableTitlebar.indexOf("performDrag"));
    expect(draggableTitlebar.indexOf("performZoom")).toBeLessThan(draggableTitlebar.indexOf("performDrag"));
    const mouseDown = draggableTitlebar.slice(draggableTitlebar.indexOf("override func mouseDown"));
    expect(mouseDown.match(/dismissWebTopBarMenus\(\)/gu)).toHaveLength(2);
    expect(mouseDown.indexOf("dismissWebTopBarMenus()")).toBeLessThan(mouseDown.indexOf("performZoom"));
    expect(mouseDown.lastIndexOf("dismissWebTopBarMenus()")).toBeGreaterThan(mouseDown.indexOf("performDrag"));
    expect(draggableTitlebar).not.toContain("override func hitTest");
  });

  it("publishes scaled native button frames and aligns their AppKit hit targets", async () => {
    const windowSource = await readFile(
      resolve("apps/macos/Sources/PlacekeeperMac/PlacekeeperWindowController.swift"),
      "utf8",
    );
    const alignment = windowSource.slice(
      windowSource.indexOf("private func alignTrafficLights"),
      windowSource.indexOf("private func diagnostic"),
    );
    expect(windowSource).toContain("window.addTitlebarAccessoryViewController(titlebarSpacing)");
    expect(windowSource).toContain('"trafficLightBounds": trafficLightBounds()');
    expect(alignment).toContain("Self.toolbarHeight * scale");
    expect(alignment).toContain("y: centerInSuperview.y - button.frame.height / 2");
    const buttonGeometry = windowSource.slice(
      windowSource.indexOf("private func trafficLightInset"),
      windowSource.indexOf("private func alignTrafficLights"),
    );
    expect(buttonGeometry).toContain('guard !window.styleMask.contains(.fullScreen) else { return Double(Self.toolbarHorizontalMargin) / webView.pageZoom }');
    expect(buttonGeometry).toContain('AppZoomGeometry.cssRect');
    expect(buttonGeometry).toContain('guard let window, !window.styleMask.contains(.fullScreen) else { return [] }');
    expect(windowSource).toContain('window?.toolbar?.isVisible = false');
    expect(windowSource).toContain('window?.toolbar?.isVisible = true');
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
      PLACEKEEPER_MAC_DEVELOPMENT_ROOT: "/tmp/placekeeper-native-smoke",
      PLACEKEEPER_MAC_DEVELOPMENT_HTTP_PORT: "43128",
      PLACEKEEPER_PDFIUM_WASM: "/Applications/Placekeeper.app/Contents/Resources/pdfium/pdfium.wasm",
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
      PLACEKEEPER_MAC_DEVELOPMENT_ROOT: "/tmp/placekeeper-native-smoke",
      PLACEKEEPER_MAC_DEVELOPMENT_HTTP_PORT: "43128",
      PLACEKEEPER_PDFIUM_WASM: "/Applications/Placekeeper.app/Contents/Resources/pdfium/pdfium.wasm",
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
