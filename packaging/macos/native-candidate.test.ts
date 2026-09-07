import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  NATIVE_CANDIDATE_EXECUTABLE,
  minimalNativeCandidateEnvironment,
  nativeCandidateDependencyIsSystem,
  nativeCandidateNodeRuntimeCandidates,
  nativeCandidateInfoPlist,
  swiftBuildArguments,
} from "./build-native-candidate.js";

describe("macOS native candidate packaging", () => {
  it("packages the native window for normal installation and the candidate path", async () => {
    const packageManifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageManifest.scripts["package:macos"]).toBe(
      "pnpm build && pnpm build:macos:web && tsx packaging/macos/build-native-candidate.ts",
    );
    expect(packageManifest.scripts["package:macos:native-candidate"]).toBe(
      "pnpm build && pnpm build:macos:web && tsx packaging/macos/build-native-candidate.ts",
    );
    expect(packageManifest.scripts["install:local"]).toBe("/bin/sh ./install.sh");
    expect(packageManifest.scripts["notarize:macos"]).toBe("tsx packaging/macos/notarize.ts");
  });

  it("keeps the existing native payload size policy explicit", async () => {
    const [productionBuilder, candidateBuilder] = await Promise.all([
      readFile(resolve("packaging/macos/build-app.ts"), "utf8"),
      readFile(resolve("packaging/macos/build-native-candidate.ts"), "utf8"),
    ]);

    expect(productionBuilder).toContain("enforceReviewedWebSize: options.enforceReviewedWebSize");
    expect(candidateBuilder).toContain("enforceReviewedWebSize: false");
    expect(productionBuilder).not.toContain("enforceReviewedWebSize: false");
  });

  it("makes the Swift binary the sole candidate bundle entry point", () => {
    const plist = nativeCandidateInfoPlist(`<?xml version="1.0"?>
<plist><dict>
<key>CFBundleExecutable</key><string>droplet</string>
<key>CFBundleSignature</key><string>dplt</string>
<key>OSAAppletShowStartupScreen</key><false/>
</dict></plist>`);

    expect(plist).toContain(
      `<key>CFBundleExecutable</key><string>${NATIVE_CANDIDATE_EXECUTABLE}</string>`,
    );
    expect(plist).not.toContain("droplet");
    expect(plist).not.toContain("CFBundleSignature");
    expect(plist).not.toContain("OSAAppletShowStartupScreen");
  });

  it("rejects legacy AppleScript bundle residue", async () => {
    const candidateBuilder = await readFile(
      resolve("packaging/macos/build-native-candidate.ts"),
      "utf8",
    );
    for (const entry of ["Contents/PkgInfo", "Assets.car", "droplet.icns", "droplet.rsrc"]) {
      expect(candidateBuilder).toContain(entry);
    }
    expect(candidateBuilder).toContain("Native candidate retains a legacy droplet resource");
  });

  it("builds a release Swift product with explicit package, SDK, and scratch roots", () => {
    expect(swiftBuildArguments({
      packagePath: "/repo/apps/macos",
      sourceRoot: "/repo",
      scratchPath: "/tmp/placekeeper-native",
      sdkPath: "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk",
      showBinPath: false,
    })).toEqual([
      "build",
      "--disable-sandbox",
      "--configuration", "release",
      "--product", NATIVE_CANDIDATE_EXECUTABLE,
      "--package-path", "/repo/apps/macos",
      "--scratch-path", "/tmp/placekeeper-native",
      "--sdk", "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk",
      "-Xswiftc", "-file-prefix-map",
      "-Xswiftc", "/repo=.",
      "-Xswiftc", "-debug-prefix-map",
      "-Xswiftc", "/repo=.",
    ]);
  });

  it("smokes bundled helpers with no checkout path or caller PATH authority", () => {
    expect(minimalNativeCandidateEnvironment("/tmp/placekeeper-native-home")).toEqual({
      HOME: "/tmp/placekeeper-native-home",
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin",
      PLACEKEEPER_APP_INSTANCE_ID: "app_candidate_smoke",
      TMPDIR: "/tmp/placekeeper-native-home",
    });
  });

  it("finds a pinned Node runtime without consulting PATH", () => {
    expect(nativeCandidateNodeRuntimeCandidates(
      undefined,
      undefined,
      "/host/node",
      "/Users/reviewer",
    )).toEqual([
      "/host/node",
      "/Users/reviewer/Applications/Placekeeper.app/Contents/Resources/node/bin/node",
    ]);
    expect(nativeCandidateNodeRuntimeCandidates(
      "/toolchains/node",
      "/configured/node",
      "/host/node",
      "/Users/reviewer",
    )).toEqual([
      "/toolchains/node",
      "/configured/node",
      "/host/node",
      "/Users/reviewer/Applications/Placekeeper.app/Contents/Resources/node/bin/node",
    ]);
  });

  it("rejects unresolved loader-relative native dependencies", () => {
    expect(nativeCandidateDependencyIsSystem("/System/Library/Frameworks/WebKit.framework/WebKit")).toBe(true);
    expect(nativeCandidateDependencyIsSystem("/usr/lib/libSystem.B.dylib")).toBe(true);
    expect(nativeCandidateDependencyIsSystem("@rpath/Unbundled.dylib")).toBe(false);
    expect(nativeCandidateDependencyIsSystem("@loader_path/../Frameworks/Injected.dylib")).toBe(false);
    expect(nativeCandidateDependencyIsSystem("/opt/local/lib/libInjected.dylib")).toBe(false);
  });

  it("derives release helper authority from immutable bundle resources", async () => {
    const [appSource, policySource] = await Promise.all([
      readFile(resolve("apps/macos/Sources/PlacekeeperMac/PlacekeeperMac.swift"), "utf8"),
      readFile(resolve("apps/macos/Sources/PlacekeeperMac/MacPolicies.swift"), "utf8"),
    ]);

    expect(appSource).toContain("PackagedHelperEnvironmentPolicy.resolve(");
    expect(appSource).not.toContain("baseEnvironment: ProcessInfo.processInfo.environment");
    expect(appSource).toContain("allowed: allowsDevelopmentOverrides");
    expect(appSource).toContain("resolveHelperCommand(\n                allowDevelopmentOverrides: allowsDevelopmentOverrides");
    expect(policySource).toContain('appendingPathComponent("build-identity.json")');
    expect(policySource).toContain('appendingPathComponent("pdfium/pdfium.wasm")');
    expect(policySource).toContain('"PLACEKEEPER_DAEMON_IDENTITY"');
    expect(policySource).toContain('"PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY"');
  });
});
