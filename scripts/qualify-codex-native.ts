import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const nativeGateChecks = ["installed-artifact", "launcher-hook-task", "display-hook-task", "readiness-before-attestation", "attestation-before-readiness", "private-invocation-isolation", "app-only-no-panels", "two-chat-isolation", "real-prompt-current-evidence", "recovery-continuation", "ownership-denial", "independent-stdio-eof", "hidden-renewal", "chat-switch-renewal", "expand-restore-renewal", "close-disconnect", "transport-loss-disconnect", "old-attempt-denial"] as const;
/** Keep failed continuity observations; qualify fresh explicit recovery separately. */
export const nativeLifecycleAlternatives: Readonly<Record<string, string>> = {
  "hidden-renewal": "hidden-explicit-reconnect",
  "chat-switch-renewal": "chat-switch-explicit-reconnect",
  "expand-restore-renewal": "expand-restore-explicit-reconnect",
};
export interface NativeQualification {
  schemaVersion: 1;
  status: "not-run" | "passed" | "failed";
  host: { codexBuild: string; os: string; pluginVersion: string; artifactDigest: string };
  disconnectTimeoutMs: number;
  checks: { id: string; result: "not-run" | "passed" | "failed"; evidence: string; observedAt: string; actualHost: boolean }[];
}
export function validateQualification(value: NativeQualification): string[] {
  const errors: string[] = [];
  if (value.schemaVersion !== 1 || value.status !== "passed") errors.push("Qualification is not a passed version-1 report.");
  if (!value.host?.codexBuild || !value.host.os || !value.host.pluginVersion || !/^[a-f0-9]{64}$/u.test(value.host.artifactDigest)) errors.push("Exact installed host and artifact identity are required.");
  if (!Number.isSafeInteger(value.disconnectTimeoutMs) || value.disconnectTimeoutMs < 1) errors.push("Observed disconnect timeout is required.");
  for (const id of nativeGateChecks) {
    const matches = value.checks?.filter((check) => check.id === id) ?? [];
    const passed = (check: NativeQualification["checks"][number] | undefined) => check?.result === "passed" && check.actualHost === true && typeof check.evidence === "string" && check.evidence.trim().length > 0 && Number.isFinite(Date.parse(check.observedAt));
    const alternativeId = nativeLifecycleAlternatives[id];
    const alternatives = alternativeId === undefined ? [] : value.checks?.filter((check) => check.id === alternativeId) ?? [];
    const alternativePassed = alternatives.length === 1 && passed(alternatives[0]);
    if (matches.length !== 1 || (!passed(matches[0]) && !alternativePassed) || alternatives.length > 1) errors.push(`Missing actual-host pass evidence: ${id}`);
  }
  return errors;
}
/** U8 acceptance is separate from the version-1 transport/correlation gate. */
export const nativeParityChecks = ["AE1", "AE2", "AE3", "AE4", "AE5", "AE6", "AE7", "AE8", "AE9", "AE10", "keyboard-narrow-expanded", "large-resource-lifecycle", "cross-host-regressions", "installed-update"] as const;
export const nativeParityCorpus = ["text-native.pdf", "image-only.pdf", "mixed-text-image.pdf", "rotation-90-crop.pdf", "reference-navigation.pdf", "text-native-with-annotations.pdf", "docmdp-no-annotation.pdf", "encrypted-no-annotation.pdf", "large-text-heavy.pdf"] as const;
export const nativePerformanceMetrics = ["first-readable-ms", "search-ms", "selection-ms", "refresh-ms", "peak-memory-bytes"] as const;
export interface NativeParityQualification {
  schemaVersion: 2;
  unit: "U8";
  status: "not-run" | "passed" | "failed";
  host: NativeQualification["host"];
  transportGate: { reportPath: string; sha256: string; provenance: string };
  checks: (NativeQualification["checks"][number] & { evidenceScope?: "actual-codex" | "automated-regression" })[];
  corpus: { fixture: string; sha256: string; result: "not-run" | "passed" | "failed"; actualHost: boolean; evidence: string; observedAt: string }[];
  performance: { metric: string; fixture: string; native: number[]; browser: number[]; actualHost: boolean;
    sameMachine: string; evidence: string; observedAt: string; investigation: string }[];
}
const present = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
export function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
export function validateParityQualification(value: NativeParityQualification): string[] {
  const errors: string[] = [];
  if (value.schemaVersion !== 2 || value.unit !== "U8" || value.status !== "passed") errors.push("Full parity is not a passed U8 version-2 report.");
  if (!value.host || !present(value.host.codexBuild) || !present(value.host.os) || !present(value.host.pluginVersion) || !digest(value.host.artifactDigest)) errors.push("Exact installed U8 host and artifact identity are required.");
  if (!value.transportGate || !present(value.transportGate.reportPath) || !digest(value.transportGate.sha256) || !present(value.transportGate.provenance)) errors.push("Reviewed U3 transport report and unchanged-boundary provenance are required.");
  for (const id of nativeParityChecks) {
    const matches = Array.isArray(value.checks) ? value.checks.filter(check => check.id === id) : [];
    const check = matches[0];
    if (matches.length !== 1 || check?.result !== "passed" || (id === "cross-host-regressions" ? check.actualHost !== false || check.evidenceScope !== "automated-regression" : check.actualHost !== true) || !present(check.evidence) || !timestamp(check.observedAt)) errors.push(`Missing U8 ${id === "cross-host-regressions" ? "automated regression" : "actual-host pass"} evidence: ${id}`);
  }
  for (const fixture of nativeParityCorpus) {
    const matches = Array.isArray(value.corpus) ? value.corpus.filter(check => check.fixture === fixture) : [];
    const check = matches[0];
    if (matches.length !== 1 || check?.result !== "passed" || check.actualHost !== true || !digest(check.sha256) || !present(check.evidence) || !timestamp(check.observedAt)) errors.push(`Missing U8 actual-host corpus evidence: ${fixture}`);
  }
  // Representative large-text-heavy workload is the required comparison; other
  // identical-corpus workload samples may be recorded without expanding this gate.
  for (const metric of nativePerformanceMetrics) {
    const matches = Array.isArray(value.performance) ? value.performance.filter(row => row.metric === metric && row.fixture === "large-text-heavy.pdf") : [];
    const row = matches[0];
    const samples = (items: unknown): items is number[] => Array.isArray(items) && items.length >= 3 && items.every(item => typeof item === "number" && Number.isFinite(item) && item > 0);

    if (matches.length !== 1 || !row || row.actualHost !== true || !present(row.sameMachine) || !present(row.evidence) || !timestamp(row.observedAt) || !samples(row.native) || !samples(row.browser)) {
      errors.push(`Missing same-machine actual-host performance: large-text-heavy.pdf/${metric}`); continue;
    }
    if (median(row.native) > 2 * median(row.browser) && !present(row.investigation)) errors.push(`Native median exceeds twice browser baseline without investigation: large-text-heavy.pdf/${metric}`);
  }
  return errors;
}
export function parityTemplate(): NativeParityQualification {
  return { schemaVersion: 2, unit: "U8", status: "not-run", host: { codexBuild: "", os: "", pluginVersion: "", artifactDigest: "" },
    transportGate: { reportPath: "", sha256: "", provenance: "" },
    checks: nativeParityChecks.map(id => ({ id, result: "not-run", evidence: "", observedAt: "", actualHost: false, evidenceScope: id === "cross-host-regressions" ? "automated-regression" : "actual-codex" })),
    corpus: nativeParityCorpus.map(fixture => ({ fixture, sha256: "", result: "not-run", actualHost: false, evidence: "", observedAt: "" })),
    performance: nativePerformanceMetrics.map(metric => ({ metric, fixture: "large-text-heavy.pdf", native: [], browser: [], actualHost: false, sameMachine: "", evidence: "", observedAt: "", investigation: "" })) };
}
export async function qualificationMain(args: readonly string[]): Promise<number> {
  if (args.length !== 2 || !["init", "verify", "init-parity", "verify-parity"].includes(args[0] ?? "")) throw new Error("Usage: qualify-codex-native.ts init|verify|init-parity|verify-parity <report.json>");
  const file = resolve(args[1]!);
  if (args[0] === "init-parity") {
    await writeFile(file, `${JSON.stringify(parityTemplate(), null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(`Created unqualified U8 parity report: ${file}`); return 0;
  }
  if (args[0] === "verify-parity") {
    const report = JSON.parse(await readFile(file, "utf8")) as NativeParityQualification;
    const errors = validateParityQualification(report);
    if (errors.length === 0) {
      try {
        const raw = await readFile(resolve(file, "..", report.transportGate.reportPath));
        if (createHash("sha256").update(raw).digest("hex") !== report.transportGate.sha256) errors.push("U3 report digest does not match its reviewed artifact.");
        errors.push(...validateQualification(JSON.parse(raw.toString("utf8")) as NativeQualification).map(error => `U3: ${error}`));
      } catch { errors.push("Referenced U3 transport report cannot be verified."); }
    }
    console.log(errors.length === 0 ? "U8 actual-host parity evidence is complete. Evidence remains subject to human review." : errors.join("\n"));
    return errors.length === 0 ? 0 : 1;
  }
  if (args[0] === "init") {
    const template: NativeQualification = { schemaVersion: 1, status: "not-run", host: { codexBuild: "", os: "", pluginVersion: "", artifactDigest: "" }, disconnectTimeoutMs: 30_000, checks: nativeGateChecks.map((id) => ({ id, result: "not-run", evidence: "", observedAt: "", actualHost: false })) };
    await writeFile(file, `${JSON.stringify(template, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(`Created unqualified report: ${file}`); return 0;
  }
  const errors = validateQualification(JSON.parse(await readFile(file, "utf8")) as NativeQualification);
  console.log(errors.length === 0 ? "Actual-host evidence report is complete. Evidence remains subject to human review." : errors.join("\n"));
  return errors.length === 0 ? 0 : 1;
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await qualificationMain(process.argv.slice(2));
