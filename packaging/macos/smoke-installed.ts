import { execFile, spawn } from "node:child_process";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  validateBackendRuntimeManifest,
  validateCodexPlugin,
  validateSharedWebDistribution,
} from "./validate-manifest.js";
import { BUILD_IDENTITY_FILENAME, computePackagedBuildIdentity } from "./build-app.js";
import { encodePlacekeeperLink } from "../../packages/core/src/placekeeper-link.js";
import {
  INSTALLED_SMOKE_DAEMON_FLAG,
  INSTALLED_SMOKE_HTTP_PORT_FLAG,
} from "../../apps/service/src/cli/open-command.js";
import {
  MANAGEMENT_PROTOCOL_VERSION,
  managementShutdownResult,
  requestControl,
} from "../../apps/service/src/host/launch-control.js";

const execFileAsync = promisify(execFile);
const MAX_HOOK_OUTPUT_BYTES = 128 * 1024;
const CODEX_INSTALLED_LAUNCHER_COMMAND =
  '"$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper"';

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

async function retireReplacementDaemon(socketPath: string): Promise<void> {
  if ((await lstat(socketPath).catch(() => undefined))?.isSocket() !== true) return;
  const deadline = Date.now() + 6_000;
  while (true) {
    const shutdown = managementShutdownResult(await requestControl(socketPath, {
      kind: "management",
      protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
      operation: "shutdown-if-idle",
    }));
    if (shutdown?.status === "accepted") break;
    if (shutdown?.status !== "refused" || Date.now() >= deadline) {
      throw new Error("Installed smoke replacement daemon remained active after validation");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await lstat(socketPath).then(() => false, () => true)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("Installed smoke replacement daemon did not retire");
}

function parseObject(serialized: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(serialized) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

async function distinctCandidate(appPath: string, root: string): Promise<string> {
  const candidate = join(root, "candidate/Placekeeper.app");
  await mkdir(dirname(candidate), { recursive: true });
  await cp(resolve(appPath), candidate, { recursive: true });
  const contents = join(candidate, "Contents");
  const resources = join(contents, "Resources");
  await writeFile(join(resources, "web/upgrade-smoke.txt"), "distinct packaged candidate\n");
  const identity = await computePackagedBuildIdentity({
    contentsRoot: contents,
    serviceRoot: join(resources, "service"),
    webRoot: join(resources, "web"),
  });
  await writeFile(join(resources, BUILD_IDENTITY_FILENAME), `${JSON.stringify(identity)}\n`);
  return candidate;
}

async function coordinateInstalled(
  executable: string,
  candidate: string,
  installed: string,
  environment: NodeJS.ProcessEnv,
  repoRoot: string,
  httpPort: number,
): Promise<{ readonly code: number; readonly response: Record<string, unknown> }> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(executable, [
      "daemon", "coordinate-install",
      "--candidate-app", candidate,
      "--installed-app", installed,
      "--replace-helper", resolve(repoRoot, "packaging/macos/install-built-app.sh"),
      INSTALLED_SMOKE_DAEMON_FLAG, INSTALLED_SMOKE_HTTP_PORT_FLAG, String(httpPort),
    ], { encoding: "utf8", env: environment, timeout: 30_000, maxBuffer: MAX_HOOK_OUTPUT_BYTES }, (error, stdout) => {
      const code = (error as NodeJS.ErrnoException & { code?: number } | null)?.code;
      if (error !== null && typeof code !== "number") reject(error);
      else resolvePromise({ code: typeof code === "number" ? code : 0, response: parseObject(stdout, "upgrade coordination") });
    });
    child.stdin?.end();
  });
}

async function availableSmokePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error("Installed smoke could not reserve a loopback port");
  }
  await new Promise<void>((resolveClose, reject) => server.close((error) => error === undefined ? resolveClose() : reject(error)));
  return address.port;
}

async function waitForGurlDeliveries(logPath: string, expected: readonly string[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const delivered = await readFile(logPath, "utf8")
      .then((value) => value.trim().split("\n").filter(Boolean), () => []);
    if (expected.every((url) => delivered.includes(url))) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("Launch Services did not deliver the complete cold and warm Placekeeper URLs");
}

/** Exercise the compiled shipping applet through Launch Services without
 * touching a user's daemon or opening a browser. A copied bundle replaces
 * only the Node launcher with an argv recorder; the GURL handler and plist are
 * the same bytes that ship. */
export async function smokeInstalledLaunchServicesBridge(appPath: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const root = await mkdtemp(join("/tmp", "placekeeper-gurl-smoke-"));
  const probeApp = join(root, "Placekeeper GURL Smoke.app");
  const probeLauncher = join(probeApp, "Contents/MacOS/placekeeper");
  const logPath = join(probeApp, "Contents/Resources/gurl-smoke.log");
  const cold = "placekeeper:///tmp/Cold%20Paper%20%E2%9C%93.pdf#v=1&page=12";
  const warm = "placekeeper:///tmp/Warm%20Paper%20%252F.pdf#v=1&page=7";
  try {
    await cp(resolve(appPath), probeApp, { recursive: true });
    await writeFile(probeLauncher, `#!/bin/sh
set -eu
contents_dir=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")/.." && pwd)
if [ "$#" -eq 1 ]; then /usr/bin/printf '%s\\n' "$1" >> "$contents_dir/Resources/gurl-smoke.log"; fi
`);
    await chmod(probeLauncher, 0o755);
    await execFileAsync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", probeApp]);
    await execFileAsync("/usr/bin/open", ["-n", "-g", "-a", probeApp, cold]);
    await execFileAsync("/usr/bin/open", ["-g", "-a", probeApp, warm]);
    await waitForGurlDeliveries(logPath, [cold, warm]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type HookEvent = "PostToolUse" | "UserPromptSubmit" | "SessionEnd";

async function installedHookTimeouts(installedApp: string): Promise<Record<HookEvent, number>> {
  const pluginRoot = join(installedApp, "Contents/Resources/integrations/codex-plugin");
  await validateCodexPlugin(pluginRoot);
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
  return timeouts;
}

async function assertInstalledIdentity(installedApp: string, isolatedHome: string): Promise<void> {
  const localizedNames = await readFile(
    join(installedApp, "Contents/Resources/en.lproj/InfoPlist.strings"),
    "utf8",
  );
  if (!localizedNames.includes('"CFBundleDisplayName" = "Placekeeper";')) {
    throw new Error("Installed bundle does not present Placekeeper");
  }
  if (installedApp !== join(isolatedHome, "Applications/Placekeeper.app")) {
    throw new Error("Installed smoke is not using the canonical Placekeeper app path");
  }
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
export async function smokeInstalledHookLifecycle(appPath: string, fixturePath: string, repoRoot = process.cwd()): Promise<void> {
  // Darwin limits AF_UNIX paths to roughly 104 bytes. The system TMPDIR is
  // already long enough that the app-support suffix can cross that limit.
  const smokeHome = await mkdtemp(join("/tmp", "pp-hook-smoke-"));
  const installedApp = join(smokeHome, "Applications/Placekeeper.app");
  const executable = join(installedApp, "Contents/MacOS/placekeeper");
  const supportRoot = join(smokeHome, "Library/Application Support/Placekeeper");
  const socketPath = join(supportRoot, "control.sock");
  const supportRootSentinel = join(supportRoot, "support-content.fixture");
  await mkdir(dirname(installedApp), { recursive: true });
  await symlink(resolve(appPath), installedApp);
  const pdfPath = join(smokeHome, "Paper One ✓.pdf");
  const secondPdfPath = join(smokeHome, "second-fixture.pdf");
  await copyFile(resolve(fixturePath), pdfPath);
  await copyFile(resolve(fixturePath), secondPdfPath);
  await mkdir(supportRoot, { recursive: true });
  await writeFile(supportRootSentinel, "support-root content must survive replacement\n");
  const environment = {
    ...process.env,
    HOME: smokeHome,
    PATH: "/usr/bin:/bin",
    PLACEKEEPER_OFFLINE: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1",
  };
  const httpPort = await availableSmokePort();
  const expectedOrigin = `http://127.0.0.1:${httpPort}`;
  const daemon = spawn(executable, [
    "daemon",
    INSTALLED_SMOKE_DAEMON_FLAG,
    INSTALLED_SMOKE_HTTP_PORT_FLAG,
    String(httpPort),
  ], {
    detached: true,
    env: environment,
    stdio: "ignore",
  });
  let daemonSpawnError: Error | undefined;
  let replacementDaemonStarted = false;
  daemon.once("error", (error) => { daemonSpawnError = error; });
  try {
    await assertInstalledIdentity(installedApp, smokeHome);
    await waitForSocket(socketPath, daemon, () => daemonSpawnError);
    const hookTimeouts = await installedHookTimeouts(installedApp);
    const linkedPdfPath = await realpath(pdfPath);
    const appLink = encodePlacekeeperLink({
      path: linkedPdfPath,
      location: {
        kind: "destination",
        page: 12,
        mode: "fit-horizontal",
        params: [640],
      },
    });
    const preflight = parseObject(await executeInstalled(
      executable,
      ["open-link", "--json", "--preflight", "--link", appLink],
      environment,
    ), "installed link preflight");
    if (preflight.ok !== true || preflight.path !== linkedPdfPath || preflight.confirmationRequired !== true) {
      throw new Error("Installed link preflight did not preserve the decoded unfamiliar path");
    }
    const linkedLaunch = parseObject(await executeInstalled(
      executable,
      ["open-link", "--json", "--confirmed", "--link", appLink],
      environment,
    ), "installed confirmed link launch");
    if (linkedLaunch.ok !== true || linkedLaunch.kind !== "opened" || typeof linkedLaunch.url !== "string") {
      throw new Error("Installed confirmed link did not open a browser review");
    }
    const linkedUrl = new URL(linkedLaunch.url);
    if (linkedUrl.origin !== expectedOrigin) {
      throw new Error("Installed link launch did not use the isolated stable origin");
    }
    const linkedCapability = new URLSearchParams(linkedUrl.hash.slice(1)).get("cap");
    const linkedExchange = await fetch(`${linkedUrl.origin}${linkedUrl.pathname.replace(/\/bootstrap$/u, "/exchange")}`, {
      method: "POST",
      headers: { origin: linkedUrl.origin, "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ capability: linkedCapability }),
    });
    const linkedSession = parseObject(await linkedExchange.text(), "installed linked browser exchange");
    const linkedView = linkedSession.view as Record<string, unknown> | undefined;
    if (typeof linkedView?.pathname !== "string") {
      throw new Error("Installed linked browser exchange omitted its readable route");
    }
    const linkedReadableUrl = `${expectedOrigin}${linkedView.pathname}#v=2&page=12&mode=fit-horizontal&params=640`;
    const linkedAppLinkBase = appLink.slice(0, appLink.indexOf("#"));
    const linkedScope = parseObject(await (await fetch(
      `${linkedUrl.origin}${linkedUrl.pathname.replace(/\/bootstrap$/u, "/scope")}`,
      { headers: { authorization: `Bearer ${String(linkedSession.credential)}` } },
    )).text(), "installed linked browser scope");
    const linkedLocation = linkedScope.requestedLocation as Record<string, unknown> | undefined;
    if (
      linkedScope.launchSurface !== "browser" ||
      linkedLocation?.kind !== "destination" ||
      linkedLocation.page !== 12 ||
      linkedLocation.mode !== "fit-horizontal" ||
      !Array.isArray(linkedLocation.params) ||
      linkedLocation.params.length !== 1 ||
      linkedLocation.params[0] !== 640 ||
      "codexContext" in linkedScope
    ) {
      throw new Error("Installed linked browser scope lost its location or gained Codex authority");
    }
    const warmPreflight = parseObject(await executeInstalled(
      executable,
      ["open-link", "--json", "--preflight", "--link", appLink],
      environment,
    ), "installed warm link preflight");
    if (warmPreflight.ok !== true || warmPreflight.confirmationRequired !== false) {
      throw new Error("Installed warm exact-path link did not reuse active review ownership");
    }
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

    const exact = await coordinateInstalled(executable, resolve(appPath), installedApp, environment, repoRoot, httpPort);
    if (exact.code !== 0 || exact.response.status !== "noop") {
      throw new Error("An exact installed bundle did not reuse its running daemon");
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
    const firstSession = parseObject(await exchange.text(), "first browser exchange");

    const secondLaunch = parseObject(await executeInstalled(
      executable,
      ["open", "--json", "--surface", "finder", "--pdf", secondPdfPath],
      environment,
    ), "second installed launch");
    if (secondLaunch.ok !== true || typeof secondLaunch.url !== "string") {
      throw new Error("Installed multi-PDF launch failed");
    }
    const secondUrl = new URL(secondLaunch.url);
    const secondCapability = new URLSearchParams(secondUrl.hash.slice(1)).get("cap");
    const secondExchange = await fetch(`${secondUrl.origin}${secondUrl.pathname.replace(/\/bootstrap$/u, "/exchange")}`, {
      method: "POST",
      headers: { origin: secondUrl.origin, "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ capability: secondCapability }),
    });
    if (!secondExchange.ok) throw new Error("Second installed browser capability exchange failed");
    const secondSession = parseObject(await secondExchange.text(), "second browser exchange");
    const presenceExpiryAt = Date.now() + 5_100;

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
    const installedCommand = CODEX_INSTALLED_LAUNCHER_COMMAND;
    const evidence = current.evidence;
    if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
      throw new Error("Installed prompt context omitted evidence retrieval instructions");
    }
    const publishedInstructions = Object.values(evidence)
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    if (!publishedInstructions.includes(`${installedCommand} context items`) ||
      /(^|[^/A-Za-z0-9_-])placekeeper\s+(context|daemon)\b/mu.test(publishedInstructions)) {
      throw new Error("Installed prompt context did not publish only canonical retriever commands");
    }

    const candidate = await distinctCandidate(appPath, smokeHome);
    const deferred = await coordinateInstalled(
      join(candidate, "Contents/MacOS/placekeeper"),
      candidate,
      installedApp,
      environment,
      repoRoot,
      httpPort,
    );
    if (deferred.code === 0 || (deferred.response.error as { kind?: unknown } | undefined)?.kind !== "upgrade-required") {
      throw new Error(`An active installed multi-PDF review did not defer replacement: ${JSON.stringify(deferred)}`);
    }
    const oldIdentity = parseObject(
      await readFile(join(resolve(appPath), `Contents/Resources/${BUILD_IDENTITY_FILENAME}`), "utf8"),
      "old installed identity",
    );
    const stillInstalled = parseObject(
      await readFile(join(installedApp, `Contents/Resources/${BUILD_IDENTITY_FILENAME}`), "utf8"),
      "preserved installed identity",
    );
    if (stillInstalled.installArtifactIdentity !== oldIdentity.installArtifactIdentity) {
      throw new Error("Deferred upgrade changed the installed app");
    }
    if ((await readFile(supportRootSentinel, "utf8")) !== "support-root content must survive replacement\n") {
      throw new Error("Deferred upgrade changed arbitrary support-root content");
    }
    for (const [url, session] of [[launchUrl, firstSession], [secondUrl, secondSession]] as const) {
      const state = await fetch(`${url.origin}${url.pathname.replace(/\/bootstrap$/u, "/state")}`, {
        headers: { authorization: `Bearer ${String(session.credential)}` },
      });
      if (!state.ok) throw new Error("Deferred upgrade interrupted an existing PDF review");
    }
    const afterDeferral = parseAdditionalContext(await executeInstalled(
      executable,
      ["hook", "--event"],
      environment,
      hookInput("UserPromptSubmit"),
      hookTimeouts.UserPromptSubmit,
    ), "UserPromptSubmit");
    if (afterDeferral.currentness !== "current") {
      throw new Error("Deferred upgrade interrupted installed Codex context");
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

    // Capability exchange records browser activity with a bounded close grace.
    // With no live WebSocket in this headless smoke, lease expiry represents
    // closed pages; SessionEnd above separately releases the task blocker.
    const remainingPresenceGrace = presenceExpiryAt - Date.now();
    if (remainingPresenceGrace > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, remainingPresenceGrace));
    }
    const upgraded = await coordinateInstalled(
      join(candidate, "Contents/MacOS/placekeeper"),
      candidate,
      installedApp,
      environment,
      repoRoot,
      httpPort,
    );
    if (upgraded.code !== 0 || upgraded.response.status !== "installed") {
      throw new Error("Closed reviews did not converge to a successful installed upgrade");
    }
    replacementDaemonStarted = true;
    await assertInstalledIdentity(installedApp, smokeHome);
    if ((await readFile(supportRootSentinel, "utf8")) !== "support-root content must survive replacement\n") {
      throw new Error("Successful upgrade changed arbitrary support-root content");
    }
    const postUpgrade = parseObject(await executeInstalled(
      executable,
      ["open", "--json", "--surface", "finder", "--pdf", pdfPath],
      environment,
    ), "post-upgrade launch");
    if (postUpgrade.ok !== true || typeof postUpgrade.url !== "string") {
      throw new Error("The ready candidate could not launch a PDF after upgrade");
    }
    const postUpgradeUrl = new URL(postUpgrade.url);
    if (postUpgradeUrl.origin !== expectedOrigin || postUpgradeUrl.origin !== linkedUrl.origin) {
      throw new Error("Installed upgrade changed the readable browser origin");
    }
    const staleReadableResponse = await fetch(linkedReadableUrl);
    const staleReadableHtml = await staleReadableResponse.text();
    if (
      !staleReadableResponse.ok ||
      !staleReadableHtml.includes("data-terminal-recovery") ||
      !staleReadableHtml.includes(`data-app-link-base="${linkedAppLinkBase}"`) ||
      !linkedReadableUrl.endsWith("#v=2&page=12&mode=fit-horizontal&params=640")
    ) {
      throw new Error("Installed upgrade did not preserve the old readable URL as inert recovery");
    }
    const postUpgradeCapability = new URLSearchParams(postUpgradeUrl.hash.slice(1)).get("cap");
    const postUpgradeExchange = await fetch(
      `${postUpgradeUrl.origin}${postUpgradeUrl.pathname.replace(/\/bootstrap$/u, "/exchange")}`,
      {
        method: "POST",
        headers: {
          origin: postUpgradeUrl.origin,
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ capability: postUpgradeCapability }),
      },
    );
    if (!postUpgradeExchange.ok) {
      throw new Error("The ready candidate could not exchange its post-upgrade browser capability");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_100));
  } finally {
    try {
      if (replacementDaemonStarted) await retireReplacementDaemon(socketPath);
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
}

export async function smokeInstalledBundle(appPath: string, fixturePath: string, repoRoot = process.cwd()): Promise<DoctorEvidence> {
  const manifest = validateBackendRuntimeManifest(JSON.parse(await readFile(resolve(repoRoot, "packaging/macos/backend-runtime-manifest.json"), "utf8")) as unknown);
  const pdfium = manifest.assets.find((asset) => asset.id === "pdfium-wasm");
  if (pdfium === undefined) throw new Error("PDFium runtime asset is absent");
  const executable = resolve(appPath, "Contents/MacOS/placekeeper");
  const result = await execFileAsync(executable, ["doctor", "--json", "--offline", "--writer", "--pdf", resolve(fixturePath)], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 65_536,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: process.env.HOME,
      PLACEKEEPER_OFFLINE: "1",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "",
    },
  });
  const evidence = validateDoctorEvidence(JSON.parse(result.stdout) as unknown, manifest.nodeVersion, pdfium.sha256);
  const vscodeLauncher = resolve(appPath, "Contents/MacOS/placekeeper-vscode");
  const launcherInfo = await lstat(vscodeLauncher);
  if (!launcherInfo.isFile() || (launcherInfo.mode & 0o111) === 0) {
    throw new Error("Installed scoped VS Code launcher is not executable");
  }
  const sharedWeb = await validateSharedWebDistribution(resolve(appPath, "Contents/Resources/web"));
  const vscodeWeb = await validateSharedWebDistribution(resolve(
    appPath,
    "Contents/Resources/integrations/vscode/dist/web",
  ));
  if (JSON.stringify(vscodeWeb) !== JSON.stringify(sharedWeb)) {
    throw new Error("Installed VS Code web assets differ from the shared production client");
  }
  await execFileAsync(vscodeLauncher, [
    "--registration", "invalid",
    "--pdf", resolve(fixturePath),
  ], { encoding: "utf8", timeout: 5_000, maxBuffer: 4_096 }).then(
    () => { throw new Error("Installed scoped VS Code launcher accepted an invalid registration"); },
    () => undefined,
  );
  await smokeInstalledLaunchServicesBridge(appPath);
  await smokeInstalledHookLifecycle(appPath, fixturePath, repoRoot);
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
