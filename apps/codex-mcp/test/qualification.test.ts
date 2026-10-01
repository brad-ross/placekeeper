import { describe, expect, it } from "vitest";
import { nativeGateChecks, validateQualification, type NativeQualification } from "../../../scripts/qualify-codex-native.js";
describe("actual-host qualification evidence", () => {
  it("does not accept synthetic coverage or omitted lifecycle evidence", () => {
    const report: NativeQualification = { schemaVersion: 1, status: "passed", host: { codexBuild: "build", os: "macOS", pluginVersion: "version", artifactDigest: "a".repeat(64) }, disconnectTimeoutMs: 30_000, checks: nativeGateChecks.map((id) => ({ id, result: "passed", evidence: "synthetic unit test", observedAt: new Date().toISOString(), actualHost: false })) };
    expect(validateQualification(report)).toHaveLength(nativeGateChecks.length);
    for (const check of report.checks) check.actualHost = true;
    expect(validateQualification(report)).toEqual([]);
    report.checks = report.checks.filter((check) => check.id !== "hidden-renewal");
    expect(validateQualification(report)).toEqual(["Missing actual-host pass evidence: hidden-renewal"]);
  });
});
