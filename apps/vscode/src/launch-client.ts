import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  workflowMode?: "generated-output",
): Promise<SuccessfulLaunch | RecoveryLaunch | FailedLaunch> {
  const args = ["open", "--json", "--surface", "vscode", "--pdf", pdfPath];
  if (sourceRoot !== undefined) args.push("--source-root", sourceRoot);
  if (workflowMode === "generated-output") args.push("--generated-output");
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

async function brokerMutation(
  launch: ExchangedVscodeLaunch,
  route: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(`${launch.origin}/s/${launch.sessionId}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${launch.credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Placekeeper broker rejected ${route}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 65_536) throw new Error("Placekeeper broker response was oversized");
  return text.length === 0 ? {} : JSON.parse(text) as unknown;
}

export function observeLiveDocument(
  launch: ExchangedVscodeLaunch,
  input: { readonly outputPath: string; readonly observationEpoch: number },
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  return brokerMutation(launch, "/observe", input, fetchImpl);
}

export function markLiveDocumentPossiblyStale(
  launch: ExchangedVscodeLaunch,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  return brokerMutation(launch, "/stale", {}, fetchImpl);
}

export interface ExchangedVscodeLaunch {
  readonly origin: string;
  readonly sessionId: string;
  readonly credential: string;
}

export async function exchangeVscodeLaunch(
  launchUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExchangedVscodeLaunch> {
  const url = new URL(launchUrl);
  if (
    url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port.length === 0 ||
    url.search !== "?embed=vscode" || !/^\/s\/([0-9a-f-]{36})\/bootstrap$/u.test(url.pathname) ||
    !/^#cap=[A-Za-z0-9_-]+$/u.test(url.hash) || url.username !== "" || url.password !== ""
  ) throw new Error("A scoped VS Code launch is required");
  const sessionId = /^\/s\/([0-9a-f-]{36})\/bootstrap$/u.exec(url.pathname)![1]!;
  const capability = new URLSearchParams(url.hash.slice(1)).get("cap");
  if (capability === null) throw new Error("The launch capability is missing");
  const response = await fetchImpl(`${url.origin}/s/${sessionId}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability }),
  });
  if (!response.ok) throw new Error("The launch capability was rejected");
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null ||
    typeof (value as { credential?: unknown }).credential !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test((value as { credential: string }).credential)) {
    throw new Error("The launch exchange was invalid");
  }
  return { origin: url.origin, sessionId, credential: (value as { credential: string }).credential };
}

export async function createPrivateSnapshotDirectory(storageRoot: string): Promise<string> {
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const directory = join(storageRoot, `review-${randomBytes(18).toString("base64url")}`);
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Private snapshot root is unsafe");
  return directory;
}

export async function materializePrivatePdfSnapshot(input: {
  readonly directory: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly byteLength: number;
}): Promise<string> {
  if (!/^[0-9a-f]{64}$/u.test(input.digest) || input.bytes.byteLength !== input.byteLength ||
    createHash("sha256").update(input.bytes).digest("hex") !== input.digest) {
    throw new Error("The broker-approved PDF snapshot did not match its identity");
  }
  const directoryStat = await lstat(input.directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Private snapshot root is unsafe");
  }
  const destination = join(input.directory, `${input.digest}.pdf`);
  const existing = await lstat(destination).catch(() => undefined);
  if (existing !== undefined) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== input.byteLength ||
      createHash("sha256").update(await readFile(destination)).digest("hex") !== input.digest) {
      throw new Error("Existing PDF snapshot is unsafe");
    }
    return destination;
  }
  const temporary = join(input.directory, `.snapshot-${randomBytes(18).toString("base64url")}.tmp`);
  try {
    await writeFile(temporary, input.bytes, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  const created = await lstat(destination);
  if (!created.isFile() || created.isSymbolicLink() || (created.mode & 0o777) !== 0o600) {
    throw new Error("Materialized PDF snapshot is unsafe");
  }
  return destination;
}
