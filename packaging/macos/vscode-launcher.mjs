import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SAFE_ID = /^[A-Za-z0-9_-]{16,128}$/u;

export function parseVscodeExternalLaunchArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (typeof flag !== "string" || typeof value !== "string" ||
      !["--registration", "--pdf", "--line", "--tex"].includes(flag) || values.has(flag)) {
      throw new Error("The scoped VS Code launch arguments are invalid");
    }
    values.set(flag, value);
  }
  const registrationId = values.get("--registration") ?? "";
  const outputPath = values.get("--pdf") ?? "";
  if (!SAFE_ID.test(registrationId) || !isAbsolute(outputPath) ||
    !outputPath.toLowerCase().endsWith(".pdf") || /[\0\r\n]/u.test(outputPath)) {
    throw new Error("The scoped VS Code launch must name one registered local PDF");
  }
  return Object.freeze({ registrationId, outputPath: resolve(outputPath) });
}

export function buildVscodeExternalRoute(launch) {
  if (!SAFE_ID.test(launch.registrationId) || !isAbsolute(launch.outputPath) ||
    !launch.outputPath.toLowerCase().endsWith(".pdf")) {
    throw new Error("The scoped VS Code launch is invalid");
  }
  const route = new URL("vscode://placekeeper-local.placekeeper-vscode/placekeeper/external");
  route.searchParams.set("registration", launch.registrationId);
  route.searchParams.set("pdf", resolve(launch.outputPath));
  return route.href;
}

function invoke(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolvePromise()
      : reject(new Error(`VS Code route failed with exit code ${code ?? "unknown"}`)));
  });
}

export async function launchVscodeExternalRoute(launch, invokeRoute = invoke) {
  await invokeRoute("/usr/bin/open", ["-g", buildVscodeExternalRoute(launch)], { shell: false });
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await launchVscodeExternalRoute(parseVscodeExternalLaunchArguments(process.argv.slice(2)));
}
