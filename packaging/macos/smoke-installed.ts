import { execFile, spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { validateBackendRuntimeManifest } from "./validate-manifest.js";

const execFileAsync = promisify(execFile);
const MAX_HOOK_OUTPUT_BYTES = 128 * 1024;
const CODEX_INSTALLED_LAUNCHER_COMMAND =
  '"$HOME/Applications/PDF Proofreader.app/Contents/MacOS/pdf-proofreader"';

export interface DoctorEvidence {
  readonly ok: true;
  readonly offline: true;
  readonly writer: "embedpdf-node-pdfium";
  readonly nodeVersion: string;
  readonly pdfiumSha256: string;
  readonly pages: number;
  readonly structurallyValid: true;
}

export function validateDoctorEvidence(value: unknown, expectedNode: string, expectedPdfiumDigest: string): DoctorEvidence {
  if (typeof value !== "object" || value === null) throw new Error("Doctor evidence must be an object");
  const evidence = value as Partial<DoctorEvidence>;
  if (
    evidence.ok !== true ||
    evidence.offline !== true ||
    evidence.writer !== "embedpdf-node-pdfium" ||
    evidence.nodeVersion !== expectedNode ||
    evidence.pdfiumSha256 !== expectedPdfiumDigest ||
    typeof evidence.pages !== "number" ||
    !Number.isSafeInteger(evidence.pages) ||
    evidence.pages <= 0 ||
    evidence.structurallyValid !== true
  ) {
    throw new Error("Installed writer doctor evidence did not match the distribution manifest");
  }
  return evidence as DoctorEvidence;
}

function executeInstalled(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  input?: string,
  timeoutMs = 30_000,
): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = execFile(executable, [...args], {
      encoding: "utf8",
      env: environment,
      timeout: timeoutMs,
      maxBuffer: MAX_HOOK_OUTPUT_BYTES,
    }, (error, stdout) => {
      if (error !== null) reject(error);
      else resolvePromise(stdout);
    });
    child.stdin?.end(input);
  });
}

async function waitForSocket(
  socketPath: string,
  daemon: ReturnType<typeof spawn>,
  spawnFailure: () => Error | undefined,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const failure = spawnFailure();
    if (failure !== undefined) throw failure;
    if ((await lstat(socketPath).catch(() => undefined))?.isSocket() === true) return;
    if (daemon.exitCode !== null) throw new Error(`Installed daemon exited ${daemon.exitCode}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("Installed daemon did not create its control socket");
}

function parseObject(serialized: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(serialized) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

type HookEvent = "PostToolUse" | "UserPromptSubmit" | "SessionEnd";

async function installedHookTimeouts(installedApp: string): Promise<Record<HookEvent, number>> {
  const pluginRoot = join(installedApp, "Contents/Resources/integrations/codex-plugin");
  const hooksDocument = parseObject(
    await readFile(join(pluginRoot, "hooks/hooks.json"), "utf8"),
    "installed hook manifest",
  );
  const hooks = hooksDocument.hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    throw new Error("Installed hook manifest omitted hook events");
  }
  const timeouts = {} as Record<HookEvent, number>;
  for (const event of ["PostToolUse", "UserPromptSubmit", "SessionEnd"] as const) {
    const declarations = (hooks as Record<string, unknown>)[event];
    if (!Array.isArray(declarations) || declarations.length !== 1) {
      throw new Error(`Installed hook manifest omitted ${event}`);
    }
    const declaration = declarations[0] as { hooks?: unknown };
    if (!Array.isArray(declaration.hooks) || declaration.hooks.length !== 1) {
      throw new Error(`Installed hook manifest has an invalid ${event} declaration`);
    }
    const handler = declaration.hooks[0] as { command?: unknown; timeout?: unknown };
    if (handler.command !== `${CODEX_INSTALLED_LAUNCHER_COMMAND} hook --event`) {
      throw new Error(`Installed ${event} hook does not use the canonical launcher`);
    }
    if (typeof handler.timeout !== "number" || handler.timeout <= 0) {
      throw new Error(`Installed ${event} hook has no bounded timeout`);
    }
    timeouts[event] = handler.timeout * 1_000;
  }
  const skill = await readFile(join(pluginRoot, "skills/pdf-proofreader/SKILL.md"), "utf8");
  if (!skill.includes(`${CODEX_INSTALLED_LAUNCHER_COMMAND} open --json --surface codex --pdf`)) {
    throw new Error("Installed PDF Proofreader skill does not use the canonical launcher");
  }
  return timeouts;
}

function hookInput(
  event: HookEvent,
  launch?: Record<string, unknown>,
  pdfPath?: string,
): string {
  return JSON.stringify({
    session_id: "installed-hook-smoke",
    hook_event_name: event,
    ...(event === "PostToolUse" ? {
      tool_name: "Bash",
      tool_input: {
        command: `${CODEX_INSTALLED_LAUNCHER_COMMAND} open --json --surface codex --pdf '${pdfPath}'`,
      },
      tool_response: JSON.stringify(launch),
    } : {}),
    ...(event === "UserPromptSubmit" ? { prompt: "Verify installed live context." } : {}),
  });
}

function hookAdditionalContext(serialized: string, expectedEvent: string): string {
  const output = parseObject(serialized, `${expectedEvent} hook output`);
  const specific = output.hookSpecificOutput;
  if (typeof specific !== "object" || specific === null || Array.isArray(specific)) {
    throw new Error(`${expectedEvent} hook output omitted hookSpecificOutput`);
  }
  const hook = specific as Record<string, unknown>;
  if (hook.hookEventName !== expectedEvent || typeof hook.additionalContext !== "string") {
    throw new Error(`${expectedEvent} hook output did not match the installed contract`);
  }
  return hook.additionalContext;
}

function parseAdditionalContext(serialized: string, expectedEvent: string): Record<string, unknown> {
  return parseObject(
    hookAdditionalContext(serialized, expectedEvent),
    `${expectedEvent} additional context`,
  );
}

/** Exercise the copied plugin contract through the installed app executable,
 * with an isolated home and a real daemon so no user review state is touched. */
export async function smokeInstalledHookLifecycle(appPath: string, fixturePath: string): Promise<void> {
  // Darwin limits AF_UNIX paths to roughly 104 bytes. The system TMPDIR is
  // already long enough that the app-support suffix can cross that limit.
  const smokeHome = await mkdtemp(join("/tmp", "pp-hook-smoke-"));
  const installedApp = join(smokeHome, "Applications/PDF Proofreader.app");
  const executable = join(installedApp, "Contents/MacOS/pdf-proofreader");
  const socketPath = join(smokeHome, "Library/Application Support/PDF Proofreader/control.sock");
  await mkdir(dirname(installedApp), { recursive: true });
  await symlink(resolve(appPath), installedApp);
  const pdfPath = join(smokeHome, "fixture.pdf");
  await copyFile(resolve(fixturePath), pdfPath);
  const environment = {
    ...process.env,
    HOME: smokeHome,
    PATH: "/usr/bin:/bin",
    PDF_PROOFREADER_OFFLINE: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1",
  };
  const daemon = spawn(executable, ["daemon"], {
    detached: true,
    env: environment,
    stdio: "ignore",
  });
  let daemonSpawnError: Error | undefined;
  daemon.once("error", (error) => { daemonSpawnError = error; });
  try {
    await waitForSocket(socketPath, daemon, () => daemonSpawnError);
    const hookTimeouts = await installedHookTimeouts(installedApp);
    const launchOutput = await executeInstalled(
      executable,
      ["open", "--json", "--surface", "codex", "--pdf", pdfPath],
      environment,
    );
    const launch = parseObject(launchOutput, "installed Codex launch");
    if (
      launch.ok !== true ||
      (launch.kind !== "opened" && launch.kind !== "focused") ||
      typeof launch.url !== "string"
    ) {
      throw new Error("Installed Codex launch did not return a bindable review");
    }

    const claimOutput = await executeInstalled(
      executable,
      ["hook", "--event"],
      environment,
      hookInput("PostToolUse", launch, pdfPath),
      hookTimeouts.PostToolUse,
    );
    hookAdditionalContext(claimOutput, "PostToolUse");

    const launchUrl = new URL(launch.url);
    const capability = new URLSearchParams(launchUrl.hash.slice(1)).get("cap");
    const exchange = await fetch(`${launchUrl.origin}${launchUrl.pathname.replace(/\/bootstrap$/u, "/exchange")}`, {
      method: "POST",
      headers: {
        origin: launchUrl.origin,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ capability }),
    });
    if (!exchange.ok) throw new Error("Installed browser capability exchange failed");

    const current = parseAdditionalContext(await executeInstalled(
      executable,
      ["hook", "--event"],
      environment,
      hookInput("UserPromptSubmit"),
      hookTimeouts.UserPromptSubmit,
    ), "UserPromptSubmit");
    if (current.currentness !== "current") {
      throw new Error("Installed UserPromptSubmit hook did not receive current PDF context");
    }

    await executeInstalled(
      executable,
      ["hook", "--event"],
      environment,
      hookInput("SessionEnd"),
      hookTimeouts.SessionEnd,
    );
    const revoked = parseAdditionalContext(await executeInstalled(
      executable,
      ["hook", "--event"],
      environment,
      hookInput("UserPromptSubmit"),
      hookTimeouts.UserPromptSubmit,
    ), "UserPromptSubmit");
    if (revoked.currentness !== "unavailable") {
      throw new Error("Installed SessionEnd hook did not revoke task context");
    }
  } finally {
    if (daemon.pid !== undefined) {
      try { process.kill(-daemon.pid, "SIGTERM"); } catch { /* already stopped */ }
    }
    await Promise.race([
      new Promise<void>((resolveExit) => daemon.once("exit", () => resolveExit())),
      new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1_000)),
    ]);
    await rm(smokeHome, { recursive: true, force: true });
  }
}

export async function smokeInstalledBundle(appPath: string, fixturePath: string, repoRoot = process.cwd()): Promise<DoctorEvidence> {
  const manifest = validateBackendRuntimeManifest(JSON.parse(await readFile(resolve(repoRoot, "packaging/macos/backend-runtime-manifest.json"), "utf8")) as unknown);
  const pdfium = manifest.assets.find((asset) => asset.id === "pdfium-wasm");
  if (pdfium === undefined) throw new Error("PDFium runtime asset is absent");
  const executable = resolve(appPath, "Contents/MacOS/pdf-proofreader");
  const result = await execFileAsync(executable, ["doctor", "--json", "--offline", "--writer", "--pdf", resolve(fixturePath)], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 65_536,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: process.env.HOME,
      PDF_PROOFREADER_OFFLINE: "1",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "",
    },
  });
  const evidence = validateDoctorEvidence(JSON.parse(result.stdout) as unknown, manifest.nodeVersion, pdfium.sha256);
  await smokeInstalledHookLifecycle(appPath, fixturePath);
  return evidence;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  const appPath = args[0];
  const fixturePath = args[1];
  if (appPath === undefined || fixturePath === undefined) throw new Error("Usage: smoke-installed.ts <app-path> <pdf-fixture>");
  const evidence = await smokeInstalledBundle(appPath, fixturePath);
  process.stdout.write(`Installed offline writer and Codex hook lifecycle smoke passed (${evidence.pages} page(s)).\n`);
}
