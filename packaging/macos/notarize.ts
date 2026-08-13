import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export interface ToolInvocation {
  readonly command: "xcrun";
  readonly args: readonly string[];
}

export function createNotarizationPlan(submissionArtifact: string, stapleTarget: string, keychainProfile: string): readonly ToolInvocation[] {
  if (submissionArtifact.length === 0 || submissionArtifact.includes("\0") || stapleTarget.length === 0 || stapleTarget.includes("\0")) throw new Error("Submission and staple paths are required");
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(keychainProfile)) throw new Error("A keychain profile name is required");
  return [
    { command: "xcrun", args: ["notarytool", "submit", submissionArtifact, "--keychain-profile", keychainProfile, "--wait", "--output-format", "json"] },
    { command: "xcrun", args: ["stapler", "staple", stapleTarget] },
    { command: "xcrun", args: ["stapler", "validate", stapleTarget] },
  ];
}

async function invoke(step: ToolInvocation): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(step.command, [...step.args], { shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${step.args[0]} failed (${signal ?? code ?? "unknown"})`));
    });
  });
}

export async function notarizeAndStaple(submissionArtifact: string, stapleTarget: string, keychainProfile: string): Promise<void> {
  await access(submissionArtifact);
  await access(stapleTarget);
  for (const step of createNotarizationPlan(submissionArtifact, stapleTarget, keychainProfile)) await invoke(step);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  const artifactPath = args[0];
  const stapleTarget = args[1];
  const keychainProfile = process.env.PLACEKEEPER_NOTARY_PROFILE;
  if (artifactPath === undefined || stapleTarget === undefined || keychainProfile === undefined) {
    throw new Error("Usage: notarize.ts <submission-zip> <app-to-staple>; set PLACEKEEPER_NOTARY_PROFILE");
  }
  await notarizeAndStaple(artifactPath, stapleTarget, keychainProfile);
}
