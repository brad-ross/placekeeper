import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_OUTPUT = 65_536;

function appendRecoveryArgs(args, options) {
  if (options.recovery === undefined) return;
  args.push("--recovery", options.recovery);
  args.push("--recovery-offer-id", options.recoveryOffer.id);
  args.push("--recovery-offer-expires-at", options.recoveryOffer.expiresAt);
  args.push("--recovery-operation-id", options.recoveryOperationId);
}

export function finderServiceArgs(pdfPath, options = {}) {
  const args = ["open", "--json", "--surface", "finder", "--pdf", pdfPath];
  appendRecoveryArgs(args, options);
  return args;
}

export function linkServiceArgs(link, options = {}) {
  const args = ["open-link", "--json"];
  if (options.preflight === true) args.push("--preflight");
  if (options.confirmed === true) args.push("--confirmed");
  appendRecoveryArgs(args, options);
  args.push("--link", link);
  return args;
}

function run(executable, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const { allowNonZero = false, ...spawnOptions } = options;
    const child = spawn(executable, args, { shell: false, ...spawnOptions });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT) child.kill();
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 || allowNonZero ? resolvePromise(stdout) : reject(new Error(`Child exited ${code ?? "unknown"}`)));
  });
}

async function osascript(script, environment) {
  await run("/usr/bin/osascript", ["-e", script], {
    env: { PATH: "/usr/bin:/bin", ...environment },
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function parse(serialized) {
  if (Buffer.byteLength(serialized) > MAX_OUTPUT) throw new Error("Launch response too large");
  return JSON.parse(serialized);
}

function recoveryRequest(result, recovery) {
  const offer = result?.recoveryOffer;
  if (
    !offer || typeof offer !== "object" ||
    typeof offer.id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(offer.id) ||
    typeof offer.expiresAt !== "string" || !Number.isFinite(Date.parse(offer.expiresAt))
  ) throw new Error("Recovery offer is invalid");
  return {
    recovery,
    recoveryOffer: { id: offer.id, expiresAt: offer.expiresAt },
    recoveryOperationId: randomBytes(18).toString("base64url"),
  };
}

function readBuildIdentity(resources) {
  const identity = JSON.parse(readFileSync(resolve(resources, "build-identity.json"), "utf8"));
  if (
    identity?.managementProtocolVersion !== 1 ||
    !/^[a-f0-9]{64}$/u.test(identity?.daemonIdentity ?? "") ||
    !/^[a-f0-9]{64}$/u.test(identity?.installArtifactIdentity ?? "")
  ) throw new Error("Installed Placekeeper build identity is invalid");
  return identity;
}

async function nativeError(error) {
  if (!error || !["input-unavailable", "unsupported-context", "upgrade-required"].includes(error.kind)) return;
  await osascript(
    NATIVE_ERROR_SCRIPT,
    { PLACEKEEPER_MESSAGE: String(error.message), PLACEKEEPER_ACTION: String(error.recoveryAction) },
  );
}

export const NATIVE_ERROR_SCRIPT = 'use framework "AppKit"\nset processEnvironment to current application\'s NSProcessInfo\'s processInfo()\'s environment()\nset alertMessage to (processEnvironment\'s objectForKey:"PLACEKEEPER_MESSAGE") as text\nset alertAction to (processEnvironment\'s objectForKey:"PLACEKEEPER_ACTION") as text\nset alert to current application\'s NSAlert\'s alloc()\'s init()\nalert\'s setMessageText:alertMessage\nalert\'s addButtonWithTitle:alertAction\nalert\'s runModal()';

async function chooseFinderPdf() {
  const selected = (await run("/usr/bin/osascript", ["-e", 'POSIX path of (choose file of type {"com.adobe.pdf"} with prompt "Choose one readable local PDF")'], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "ignore"],
    allowNonZero: true,
  })).trim();
  return selected.startsWith("/") && selected.toLowerCase().endsWith(".pdf") ? selected : undefined;
}

export const LINK_CONFIRMATION_SCRIPT = String.raw`
use framework "AppKit"

set processEnvironment to current application's NSProcessInfo's processInfo()'s environment()
set pdfPath to (processEnvironment's objectForKey:"PLACEKEEPER_LINK_PATH") as text
set alert to current application's NSAlert's alloc()'s init()
alert's setMessageText:"Open this PDF in Placekeeper?"
alert's setInformativeText:"Confirm the complete local path before Placekeeper reads the file."

set accessoryFrame to current application's NSMakeRect(0, 0, 520, 112)
set accessory to current application's NSView's alloc()'s initWithFrame:accessoryFrame
set pathLabel to current application's NSTextField's labelWithString:"PDF path"
set pathLabelFrame to current application's NSMakeRect(0, 92, 520, 20)
pathLabel's setFrame:pathLabelFrame
accessory's addSubview:pathLabel
set scrollFrame to current application's NSMakeRect(0, 0, 520, 88)
set scrollView to current application's NSScrollView's alloc()'s initWithFrame:scrollFrame
scrollView's setHasVerticalScroller:true
scrollView's setHasHorizontalScroller:true
scrollView's setBorderType:(current application's NSBezelBorder)
set pathFieldFrame to current application's NSMakeRect(0, 0, 516, 84)
set pathField to current application's NSTextView's alloc()'s initWithFrame:pathFieldFrame
pathField's setString:pdfPath
pathField's setSelectable:true
pathField's setEditable:false
pathField's setRichText:false
scrollView's setDocumentView:pathField
accessory's addSubview:scrollView
alert's setAccessoryView:accessory

set cancelButton to alert's addButtonWithTitle:"Cancel"
cancelButton's setKeyEquivalent:(character id 27)
alert's addButtonWithTitle:"Open"
set response to alert's runModal()
if response is (current application's NSAlertSecondButtonReturn) then return "open"
return "cancel"
`;

async function confirmLinkedPath(path) {
  const choice = (await run("/usr/bin/osascript", ["-l", "AppleScript", "-e", LINK_CONFIRMATION_SCRIPT], {
    env: { PATH: "/usr/bin:/bin", PLACEKEEPER_LINK_PATH: path },
    stdio: ["ignore", "pipe", "ignore"],
    allowNonZero: true,
  })).trim();
  return choice === "open";
}

async function openLinkedPdf(nodePath, serviceEntry, link, serviceEnvironment) {
  const invoke = async (options) => parse(await run(
    nodePath,
    [serviceEntry, ...linkServiceArgs(link, options)],
    { env: serviceEnvironment, allowNonZero: true },
  ));
  const preflight = await invoke({ preflight: true });
  if (preflight.ok !== true || preflight.kind !== "link-preflight" || typeof preflight.path !== "string") {
    await nativeError(preflight.error);
    return;
  }

  let confirmed = false;
  if (preflight.confirmationRequired === true) {
    confirmed = await confirmLinkedPath(preflight.path);
    if (!confirmed) return;
  }

  let result = await invoke(confirmed ? { confirmed: true } : {});
  if (result.ok === true && result.kind === "confirmation-required" && typeof result.path === "string") {
    confirmed = await confirmLinkedPath(result.path);
    if (!confirmed) return;
    result = await invoke({ confirmed: true });
  }
  if (result.ok === true && result.kind === "recovery-offered") {
    const choice = await chooseRecoveryDecision();
    if (choice === undefined) return;
    const recovery = recoveryRequest(result, choice);
    result = await invoke({ ...(confirmed ? { confirmed: true } : {}), ...recovery });
    if (result.ok === true && result.kind === "confirmation-required" && typeof result.path === "string") {
      confirmed = await confirmLinkedPath(result.path);
      if (!confirmed) return;
      result = await invoke({ confirmed: true, ...recovery });
    }
  }
  if (result.ok !== true) {
    await nativeError(result.error);
    return;
  }
  await openValidatedLaunchUrl(result);
}

async function chooseRecoveryDecision() {
  const choice = (await run("/usr/bin/osascript", ["-e", 'choose from list {"resume", "discard", "fork"} with title "Recover Placekeeper draft" without multiple selections allowed and empty selection allowed'], { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore"] })).trim();
  return ["resume", "discard", "fork"].includes(choice) ? choice : undefined;
}

async function openValidatedLaunchUrl(result) {
  if (!["opened", "focused"].includes(result.kind) || typeof result.url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/s\/[^/]+\/bootstrap#cap=[A-Za-z0-9_-]+$/u.test(result.url)) return;
  await osascript(
    OPEN_LOCATION_SCRIPT,
    { PLACEKEEPER_URL: result.url },
  );
}

export const OPEN_LOCATION_SCRIPT = 'use framework "AppKit"\nset processEnvironment to current application\'s NSProcessInfo\'s processInfo()\'s environment()\nset launchUrl to (processEnvironment\'s objectForKey:"PLACEKEEPER_URL") as text\nset nativeUrl to current application\'s NSURL\'s URLWithString:launchUrl\nif nativeUrl is missing value then error "Invalid Placekeeper launch URL"\ncurrent application\'s NSWorkspace\'s sharedWorkspace()\'s openURL:nativeUrl';

async function openFinderPdf(nodePath, serviceEntry, pdfPath, serviceEnvironment, allowInputRecovery = true) {
  let result = parse(await run(nodePath, [serviceEntry, ...finderServiceArgs(pdfPath)], { env: serviceEnvironment, allowNonZero: true }));
  if (result.ok === true && result.kind === "recovery-offered") {
    const choice = await chooseRecoveryDecision();
    if (choice === undefined) return;
    result = parse(await run(nodePath, [serviceEntry, ...finderServiceArgs(
      pdfPath,
      recoveryRequest(result, choice),
    )], { env: serviceEnvironment, allowNonZero: true }));
  }
  if (result.ok !== true) {
    await nativeError(result.error);
    if (allowInputRecovery && result.error?.kind === "input-unavailable") {
      const selected = await chooseFinderPdf();
      if (selected !== undefined) await openFinderPdf(nodePath, serviceEntry, selected, serviceEnvironment, false);
    }
    return;
  }
  await openValidatedLaunchUrl(result);
}

export async function main(args = process.argv.slice(2)) {
  const resources = dirname(fileURLToPath(import.meta.url));
  const nodePath = resolve(resources, "node/bin/node");
  const serviceEntry = resolve(resources, "service/main.js");
  const buildIdentity = readBuildIdentity(resources);
  const serviceEnvironment = {
    ...process.env,
    PLACEKEEPER_PDFIUM_WASM: resolve(resources, "pdfium/pdfium.wasm"),
    PLACEKEEPER_DAEMON_IDENTITY: buildIdentity.daemonIdentity,
    PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY: buildIdentity.installArtifactIdentity,
    PLACEKEEPER_WEB_ASSETS: resolve(resources, "web"),
  };
  if (args.length === 1 && args[0].startsWith("placekeeper:")) {
    await openLinkedPdf(nodePath, serviceEntry, args[0], serviceEnvironment);
    return;
  }
  if (args.length === 1 && resolve(args[0]) === args[0] && args[0].toLowerCase().endsWith(".pdf")) {
    await openFinderPdf(nodePath, serviceEntry, args[0], serviceEnvironment);
    return;
  }
  const child = spawn(nodePath, [serviceEntry, ...args], { shell: false, stdio: "inherit", env: serviceEnvironment });
  await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`Service exited ${code ?? "unknown"}`)));
  });
}

function isMainModule() {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) await main();
