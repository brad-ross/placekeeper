import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  parseLaunchResponse,
  type FailedLaunch,
  type RecoveryDecision,
  type RecoveryLaunch,
  type SuccessfulLaunch,
} from "./review-panel.js";

const execFileAsync = promisify(execFile);

export interface LaunchInvocationOptions {
  readonly shell: false;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export type LaunchInvoker = (
  executable: string,
  args: readonly string[],
  options: LaunchInvocationOptions,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

const defaultInvoker: LaunchInvoker = async (executable, args, options) => {
  try {
    const result = await execFileAsync(executable, [...args], {
      shell: options.shell,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      encoding: "utf8",
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const output = error as { stdout?: unknown; stderr?: unknown };
    if (typeof output.stdout !== "string" || output.stdout.length === 0) throw error;
    return {
      stdout: output.stdout,
      stderr: typeof output.stderr === "string" ? output.stderr : "",
    };
  }
};

export async function runLaunchClient(
  executable: string,
  pdfPath: string,
  sourceRoot: string | undefined,
  invoke: LaunchInvoker = defaultInvoker,
  recovery?: {
    readonly decision: RecoveryDecision;
    readonly offer: RecoveryLaunch["recoveryOffer"];
    readonly operationId: string;
  },
): Promise<SuccessfulLaunch | RecoveryLaunch | FailedLaunch> {
  const args = ["open", "--json", "--surface", "vscode", "--pdf", pdfPath];
  if (sourceRoot !== undefined) args.push("--source-root", sourceRoot);
  if (recovery !== undefined) {
    args.push("--recovery", recovery.decision);
    args.push("--recovery-offer-id", recovery.offer.id);
    args.push("--recovery-offer-expires-at", recovery.offer.expiresAt);
    args.push("--recovery-operation-id", recovery.operationId);
  }
  const { stdout } = await invoke(executable, args, {
    shell: false,
    timeoutMs: 15_000,
    maxOutputBytes: 65_536,
  });
  return parseLaunchResponse(stdout.trim());
}
