import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_OUTPUT = 65_536;

export function finderServiceArgs(pdfPath, recovery) {
  const args = ["open", "--json", "--surface", "finder", "--pdf", pdfPath];
  if (recovery !== undefined) args.push("--recovery", recovery);
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

function readBuildIdentity(resources) {
  const identity = JSON.parse(readFileSync(resolve(resources, "build-identity.json"), "utf8"));
  if (
    identity?.managementProtocolVersion !== 1 ||
    !/^[a-f0-9]{64}$/u.test(identity?.daemonIdentity ?? "") ||
    !/^[a-f0-9]{64}$/u.test(identity?.installArtifactIdentity ?? "")
  ) throw new Error("Installed PDF Proofreader build identity is invalid");
  return identity;
}

async function nativeError(error) {
  if (!error || !["input-unavailable", "unsupported-context", "upgrade-required"].includes(error.kind)) return;
  await osascript(
    'display alert (system attribute "PDF_PROOFREADER_MESSAGE") buttons {(system attribute "PDF_PROOFREADER_ACTION")}',
    { PDF_PROOFREADER_MESSAGE: String(error.message), PDF_PROOFREADER_ACTION: String(error.recoveryAction) },
  );
}

async function chooseFinderPdf() {
  const selected = (await run("/usr/bin/osascript", ["-e", 'POSIX path of (choose file of type {"com.adobe.pdf"} with prompt "Choose one readable local PDF")'], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "ignore"],
    allowNonZero: true,
  })).trim();
  return selected.startsWith("/") && selected.toLowerCase().endsWith(".pdf") ? selected : undefined;
}

async function openFinderPdf(nodePath, serviceEntry, pdfPath, serviceEnvironment, allowInputRecovery = true) {
  let result = parse(await run(nodePath, [serviceEntry, ...finderServiceArgs(pdfPath)], { env: serviceEnvironment, allowNonZero: true }));
  if (result.ok === true && result.kind === "recovery-offered") {
    const choice = (await run("/usr/bin/osascript", ["-e", 'choose from list {"resume", "discard", "fork"} with title "Recover PDF Proofreader draft" without multiple selections allowed and empty selection allowed'], { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore"] })).trim();
    if (!["resume", "discard", "fork"].includes(choice)) return;
    result = parse(await run(nodePath, [serviceEntry, ...finderServiceArgs(pdfPath, choice)], { env: serviceEnvironment, allowNonZero: true }));
  }
  if (result.ok !== true) {
    await nativeError(result.error);
    if (allowInputRecovery && result.error?.kind === "input-unavailable") {
      const selected = await chooseFinderPdf();
      if (selected !== undefined) await openFinderPdf(nodePath, serviceEntry, selected, serviceEnvironment, false);
    }
    return;
  }
  if (!["opened", "focused"].includes(result.kind) || typeof result.url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/s\/[^/]+\/bootstrap#cap=[A-Za-z0-9_-]+$/u.test(result.url)) return;
  await osascript('open location (system attribute "PDF_PROOFREADER_URL")', { PDF_PROOFREADER_URL: result.url });
}

export async function main(args = process.argv.slice(2)) {
  const resources = dirname(fileURLToPath(import.meta.url));
  const nodePath = resolve(resources, "node/bin/node");
  const serviceEntry = resolve(resources, "service/main.js");
  const buildIdentity = readBuildIdentity(resources);
  const serviceEnvironment = {
    ...process.env,
    PDF_PROOFREADER_PDFIUM_WASM: resolve(resources, "pdfium/pdfium.wasm"),
    PDF_PROOFREADER_DAEMON_IDENTITY: buildIdentity.daemonIdentity,
    PDF_PROOFREADER_INSTALL_ARTIFACT_IDENTITY: buildIdentity.installArtifactIdentity,
  };
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
