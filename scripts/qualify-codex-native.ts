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
export async function qualificationMain(args: readonly string[]): Promise<number> {
  if (args.length !== 2 || !["init", "verify"].includes(args[0] ?? "")) throw new Error("Usage: qualify-codex-native.ts init|verify <report.json>");
  const file = resolve(args[1]!);
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
