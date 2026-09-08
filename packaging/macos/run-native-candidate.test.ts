import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  nativeCandidateDaemonArguments,
  nativeCandidatePaths,
  nativeCandidateRunnerEnvironment,
  parseNativeCandidateRunnerArguments,
  parsePackagedBuildIdentity,
} from "./run-native-candidate.js";

const identity = {
  managementProtocolVersion: 1 as const,
  daemonIdentity: "a".repeat(64),
  installArtifactIdentity: "b".repeat(64),
};

describe("macOS native candidate runner", () => {
  it("keeps the isolated runner available alongside native installation", async () => {
    const packageManifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageManifest.scripts["run:macos:native-candidate"]).toBe(
      "tsx packaging/macos/run-native-candidate.ts",
    );
    expect(packageManifest.scripts["package:macos"]).toBe(
      "pnpm build && pnpm build:macos:web && tsx packaging/macos/build-native-candidate.ts",
    );
    expect(packageManifest.scripts["install:local"]).toBe("/bin/sh ./install.sh");
  });

  it("parses a bounded smoke request and defaults to the review fixture", () => {
    expect(parseNativeCandidateRunnerArguments(["--", "--smoke"], "/repo"))
      .toEqual({
        pdfPath: "/repo/test/fixtures/pdfs/multi-page-text.pdf",
        smoke: true,
        timeoutMs: 60_000,
      });
    expect(parseNativeCandidateRunnerArguments(["--", "--smoke", "--timeout-ms", "45000"], "/repo"))
      .toEqual({
        pdfPath: "/repo/test/fixtures/pdfs/multi-page-text.pdf",
        smoke: true,
        timeoutMs: 45_000,
      });
    expect(() => parseNativeCandidateRunnerArguments(["--timeout-ms", "999"], "/repo"))
      .toThrow("--timeout-ms must be an integer");
    expect(() => parseNativeCandidateRunnerArguments(["--replace-installed"], "/repo"))
      .toThrow("Unsupported native candidate option");
  });

  it("accepts only the closed packaged identity schema", () => {
    expect(parsePackagedBuildIdentity(identity)).toEqual(identity);
    expect(() => parsePackagedBuildIdentity({ ...identity, extra: true })).toThrow("invalid");
    expect(() => parsePackagedBuildIdentity({ ...identity, daemonIdentity: "development" })).toThrow("invalid");
    expect(() => parsePackagedBuildIdentity({ ...identity, managementProtocolVersion: 2 })).toThrow("invalid");
  });

  it("derives every executable and asset from the selected bundle", () => {
    expect(nativeCandidatePaths("/tmp/Candidate.app")).toEqual({
      appPath: "/tmp/Candidate.app",
      executable: "/tmp/Candidate.app/Contents/MacOS/PlacekeeperMac",
      nodeRuntime: "/tmp/Candidate.app/Contents/Resources/node/bin/node",
      serviceEntry: "/tmp/Candidate.app/Contents/Resources/service/main.js",
      webRoot: "/tmp/Candidate.app/Contents/Resources/web",
      macWebRoot: "/tmp/Candidate.app/Contents/Resources/MacWeb",
      pdfiumWasm: "/tmp/Candidate.app/Contents/Resources/pdfium/pdfium.wasm",
      identityPath: "/tmp/Candidate.app/Contents/Resources/build-identity.json",
    });
  });

  it("starts the bundled daemon through the isolated installed-smoke seam", () => {
    const paths = nativeCandidatePaths("/tmp/Candidate.app");
    expect(nativeCandidateDaemonArguments(paths, 43191)).toEqual([
      paths.serviceEntry,
      "daemon",
      "--isolated-installed-smoke",
      "--http-port",
      "43191",
    ]);
  });

  it("uses private minimal environments with bundle-derived authority", () => {
    const paths = nativeCandidatePaths("/tmp/Candidate.app");
    const environment = nativeCandidateRunnerEnvironment(paths, identity, "/tmp/private-home", 43191, true);
    const shared = {
      HOME: "/tmp/private-home",
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin",
      TMPDIR: "/tmp/private-home",
      PLACEKEEPER_DAEMON_IDENTITY: identity.daemonIdentity,
      PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY: identity.installArtifactIdentity,
      PLACEKEEPER_PDFIUM_WASM: paths.pdfiumWasm,
    };
    expect(environment.daemon).toEqual({
      ...shared,
      PLACEKEEPER_WEB_ASSETS: paths.webRoot,
    });
    expect(environment.application).toEqual({
      ...shared,
      PLACEKEEPER_MAC_DEVELOPMENT_ROOT: "/tmp/private-home/Library/Application Support/Placekeeper",
      PLACEKEEPER_MAC_DEVELOPMENT_HTTP_PORT: "43191",
      PLACEKEEPER_MAC_DIAGNOSTICS: "1",
    });
    expect(environment.application).not.toHaveProperty("PLACEKEEPER_MAC_NODE");
    expect(environment.application).not.toHaveProperty("PLACEKEEPER_MAC_SERVICE_ENTRY");
    expect(environment.application).not.toHaveProperty("PLACEKEEPER_MAC_WEB_ROOT");
  });
});
