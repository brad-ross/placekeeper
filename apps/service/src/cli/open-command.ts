import { isAbsolute } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { LaunchRequest, LaunchResponse, LaunchSurface } from "../host/proofreader-host.js";
import { launchThroughDaemon, runServiceDaemon } from "../host/service-daemon.js";
import { runDoctorCommand } from "./doctor-command.js";

type LaunchClient = (request: LaunchRequest) => Promise<LaunchResponse>;

function takeValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseOpenArguments(args: readonly string[]): LaunchRequest {
  if (args[0] !== "open" || !args.includes("--json")) {
    throw new Error("Use: pdf-proofreader open --json --pdf <absolute-path>");
  }
  let pdfPath: string | undefined;
  let sourceRootPath: string | undefined;
  let fork = false;
  let recovery: "resume" | "discard" | "fork" | undefined;
  let surface: LaunchSurface | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--json") continue;
    if (argument === "--fork") {
      if (fork) throw new Error("--fork may be specified once");
      fork = true;
      continue;
    }
    if (argument === "--recovery") {
      const value = takeValue(args, index, argument);
      if (recovery !== undefined || !["resume", "discard", "fork"].includes(value)) {
        throw new Error("--recovery must be resume, discard, or fork");
      }
      recovery = value as "resume" | "discard" | "fork";
      index += 1;
      continue;
    }
    if (argument === "--pdf") {
      if (pdfPath !== undefined) throw new Error("Open one explicit PDF at a time");
      pdfPath = takeValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--source-root") {
      if (sourceRootPath !== undefined) throw new Error("Choose one source root at a time");
      sourceRootPath = takeValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--surface") {
      const value = takeValue(args, index, argument);
      if (!["browser", "finder", "codex", "vscode"].includes(value)) {
        throw new Error("Unsupported launch surface");
      }
      surface = value as LaunchSurface;
      index += 1;
      continue;
    }
    throw new Error("Open one explicit PDF at a time");
  }
  if (pdfPath === undefined) throw new Error("Open one explicit PDF at a time");
  if (!isAbsolute(pdfPath)) throw new Error("The PDF path must be absolute");
  if (sourceRootPath !== undefined && !isAbsolute(sourceRootPath)) {
    throw new Error("The source-root path must be absolute");
  }
  return {
    pdfPath,
    ...(sourceRootPath === undefined ? {} : { sourceRootPath }),
    ...(fork ? { fork: true } : {}),
    ...(recovery === undefined ? {} : { recovery }),
    ...(surface === undefined ? {} : { surface }),
  };
}

export async function runOpenCommand(
  args: readonly string[],
  launch: LaunchClient,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  let response: LaunchResponse;
  try {
    response = await launch(parseOpenArguments(args));
  } catch (error) {
    response = {
      ok: false,
      error: {
        kind: "input-unavailable",
        message: error instanceof Error ? error.message : "The launch request was invalid.",
        recoveryAction: "Choose one readable local PDF",
      },
    };
  }
  write(`${JSON.stringify(response)}\n`);
  return response.ok ? 0 : 2;
}

async function main(): Promise<number> {
  if (process.argv[2] === "doctor") {
    return runDoctorCommand(process.argv.slice(2));
  }
  if (process.argv[2] === "daemon") {
    await runServiceDaemon();
    return 0;
  }
  return runOpenCommand(process.argv.slice(2), launchThroughDaemon);
}

function isMainModule(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main().then(
    (code) => { process.exitCode = code; },
    () => {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        error: {
          kind: "input-unavailable",
          message: "The local proofreader service is unavailable.",
          recoveryAction: "Choose one readable local PDF",
        },
      })}\n`);
      process.exitCode = 2;
    },
  );
}
