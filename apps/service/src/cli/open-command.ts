import { isAbsolute } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  LaunchRequest,
  LaunchResponse,
  LaunchSurface,
  LinkLaunchResponse,
  LinkPreflightResponse,
} from "../host/placekeeper-host.js";
import { DaemonUpgradeRequiredError } from "../host/launch-control.js";
import {
  defaultDaemonPaths,
  installedSmokeDaemonPaths,
  INSTALLED_SMOKE_DAEMON_FLAG,
  INSTALLED_SMOKE_HTTP_PORT_FLAG,
  launchThroughDaemon,
  openLinkThroughDaemon,
  preflightLinkThroughDaemon,
  runServiceDaemon,
  type DaemonPaths,
} from "../host/service-daemon.js";
import { runDoctorCommand } from "./doctor-command.js";
import { readHookStdin, runHookCommand } from "./hook-command.js";
import { runContextCommand } from "./context-command.js";
import { runDaemonCommand } from "./daemon-command.js";
import { PLACEKEEPER_LINK_MAX_LENGTH } from "../../../../packages/core/src/placekeeper-link.js";
import { runChromeNativeHostCommand } from "../browser/chrome-native-host.js";
import {
  runChromePdfInspectionCommand,
  runChromePdfValidationCommand,
} from "../browser/chrome-pdf-validator.js";
import { runChromeRegistrationCommand } from "./chrome-registration-command.js";
import {
  isLaunchSurface,
  isRecoveryDecision,
  type RecoveryDecision,
  type RecoveryOfferIdentity,
} from "../sessions/session-broker.js";

const RECOVERY_ID = /^[A-Za-z0-9_-]{16,128}$/u;

type LaunchClient = (request: LaunchRequest) => Promise<LaunchResponse>;

export type ParsedOpenLinkRequest =
  | { readonly operation: "preflight"; readonly link: string }
  | {
      readonly operation: "open";
      readonly link: string;
      readonly confirmed?: true;
      readonly recovery?: RecoveryDecision;
      readonly recoveryOffer?: RecoveryOfferIdentity;
      readonly recoveryOperationId?: string;
      readonly surface?: LaunchSurface;
    };

type OpenLinkClient = (
  request: ParsedOpenLinkRequest,
) => Promise<LinkPreflightResponse | LinkLaunchResponse>;

export { INSTALLED_SMOKE_DAEMON_FLAG, INSTALLED_SMOKE_HTTP_PORT_FLAG };

/** Resolve only direct daemon launches. Management subcommands stay on their
 * existing path; the isolated installed smoke alone receives an ephemeral
 * HTTP port so it can run beside the real installed daemon. */
export function pathsForDirectDaemonLaunch(args: readonly string[]): DaemonPaths | undefined {
  if (args.length === 0) return defaultDaemonPaths();
  if (args.length === 3 && args[0] === INSTALLED_SMOKE_DAEMON_FLAG) return installedSmokeDaemonPaths(args);
  return undefined;
}

function takeValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseOpenArguments(args: readonly string[]): LaunchRequest {
  if (args[0] !== "open" || !args.includes("--json")) {
    throw new Error("Use: placekeeper open --json --pdf <absolute-path>");
  }
  let pdfPath: string | undefined;
  let sourceRootPath: string | undefined;
  let fork = false;
  let recovery: RecoveryDecision | undefined;
  let recoveryOfferId: string | undefined;
  let recoveryOfferExpiresAt: string | undefined;
  let recoveryOperationId: string | undefined;
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
      if (recovery !== undefined || !isRecoveryDecision(value)) {
        throw new Error("--recovery must be resume, discard, or fork");
      }
      recovery = value;
      index += 1;
      continue;
    }
    if (argument === "--recovery-offer-id") {
      if (recoveryOfferId !== undefined) throw new Error("--recovery-offer-id may be specified once");
      recoveryOfferId = takeValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--recovery-offer-expires-at") {
      if (recoveryOfferExpiresAt !== undefined) {
        throw new Error("--recovery-offer-expires-at may be specified once");
      }
      recoveryOfferExpiresAt = takeValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--recovery-operation-id") {
      if (recoveryOperationId !== undefined) {
        throw new Error("--recovery-operation-id may be specified once");
      }
      recoveryOperationId = takeValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--pdf") {
      if (pdfPath !== undefined) throw new Error("Open one explicit PDF at a time");
      pdfPath = takeValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--surface") {
      const value = takeValue(args, index, argument);
      if (!isLaunchSurface(value)) {
        throw new Error("Unsupported launch surface");
      }
      surface = value;
      index += 1;
      continue;
    }
    if (argument === "--source-root") {
      if (sourceRootPath !== undefined) throw new Error("Choose one source root at a time");
      sourceRootPath = takeValue(args, index, argument);
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
  const recoveryIdentityPresent = recoveryOfferId !== undefined ||
    recoveryOfferExpiresAt !== undefined || recoveryOperationId !== undefined;
  if (
    (recovery !== undefined && recovery !== "fork" && !recoveryIdentityPresent) ||
    (recoveryIdentityPresent && (
      recovery === undefined || recoveryOfferId === undefined ||
      recoveryOfferExpiresAt === undefined || recoveryOperationId === undefined ||
      !RECOVERY_ID.test(recoveryOfferId) || !RECOVERY_ID.test(recoveryOperationId) ||
      !Number.isFinite(Date.parse(recoveryOfferExpiresAt))
    ))
  ) {
    throw new Error("Recovery requires one valid offer and operation identity");
  }
  return {
    pdfPath,
    ...(sourceRootPath === undefined ? {} : { sourceRootPath }),
    ...(fork ? { fork: true } : {}),
    ...(recovery === undefined ? {} : { recovery }),
    ...(recoveryOfferId === undefined || recoveryOfferExpiresAt === undefined
      ? {}
      : { recoveryOffer: { id: recoveryOfferId, expiresAt: recoveryOfferExpiresAt } }),
    ...(recoveryOperationId === undefined ? {} : { recoveryOperationId }),
    ...(surface === undefined ? {} : { surface }),
  };
}

export function parseOpenLinkArguments(args: readonly string[]): ParsedOpenLinkRequest {
  if (args[0] !== "open-link" || !args.includes("--json")) {
    throw new Error("Use: placekeeper open-link --json --preflight|--confirmed --link <placekeeper-url>");
  }
  let link: string | undefined;
  let preflight = false;
  let confirmed = false;
  let recovery: RecoveryDecision | undefined;
  let recoveryOfferId: string | undefined;
  let recoveryOfferExpiresAt: string | undefined;
  let recoveryOperationId: string | undefined;
  let surface: LaunchSurface | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--json") continue;
    if (argument === "--preflight") {
      if (preflight) throw new Error("--preflight may be specified once");
      preflight = true;
      continue;
    }
    if (argument === "--confirmed") {
      if (confirmed) throw new Error("--confirmed may be specified once");
      confirmed = true;
      continue;
    }
    if (argument === "--recovery") {
      const value = takeValue(args, index, argument);
      if (recovery !== undefined || !isRecoveryDecision(value)) {
        throw new Error("--recovery must be resume, discard, or fork");
      }
      recovery = value;
      index += 1;
      continue;
    }
    if (argument === "--recovery-offer-id") {
      if (recoveryOfferId !== undefined) throw new Error("--recovery-offer-id may be specified once");
      recoveryOfferId = takeValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--recovery-offer-expires-at") {
      if (recoveryOfferExpiresAt !== undefined) {
        throw new Error("--recovery-offer-expires-at may be specified once");
      }
      recoveryOfferExpiresAt = takeValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--recovery-operation-id") {
      if (recoveryOperationId !== undefined) {
        throw new Error("--recovery-operation-id may be specified once");
      }
      recoveryOperationId = takeValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--surface") {
      const value = takeValue(args, index, argument);
      if (surface !== undefined || !isLaunchSurface(value)) {
        throw new Error("Unsupported launch surface");
      }
      surface = value;
      index += 1;
      continue;
    }
    if (argument === "--link") {
      if (link !== undefined) throw new Error("Open one Placekeeper link at a time");
      link = takeValue(args, index, argument);
      index += 1;
      continue;
    }
    throw new Error("Open one Placekeeper link at a time");
  }
  if (link === undefined) throw new Error("Open one Placekeeper link at a time");
  if (link.length > PLACEKEEPER_LINK_MAX_LENGTH) throw new Error("Placekeeper link exceeds the length limit");
  const recoveryIdentityPresent = recoveryOfferId !== undefined ||
    recoveryOfferExpiresAt !== undefined || recoveryOperationId !== undefined;
  if (
    (recovery !== undefined && recovery !== "fork" && !recoveryIdentityPresent) ||
    (recoveryIdentityPresent && (
      recovery === undefined || recoveryOfferId === undefined ||
      recoveryOfferExpiresAt === undefined || recoveryOperationId === undefined ||
      !RECOVERY_ID.test(recoveryOfferId) || !RECOVERY_ID.test(recoveryOperationId) ||
      !Number.isFinite(Date.parse(recoveryOfferExpiresAt))
    ))
  ) {
    throw new Error("Recovery requires one valid offer and operation identity");
  }
  if (preflight && (confirmed || recovery !== undefined || recoveryIdentityPresent || surface !== undefined)) {
    throw new Error("Link preflight cannot be confirmed or choose recovery");
  }
  return preflight
    ? { operation: "preflight", link }
    : {
        operation: "open",
        link,
        ...(confirmed ? { confirmed: true } : {}),
        ...(recovery === undefined ? {} : { recovery }),
        ...(recoveryOfferId === undefined || recoveryOfferExpiresAt === undefined
          ? {}
          : { recoveryOffer: { id: recoveryOfferId, expiresAt: recoveryOfferExpiresAt } }),
        ...(recoveryOperationId === undefined ? {} : { recoveryOperationId }),
        ...(surface === undefined ? {} : { surface }),
      };
}

export async function runOpenLinkCommand(
  args: readonly string[],
  launch: OpenLinkClient,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  let response: LinkPreflightResponse | LinkLaunchResponse;
  try {
    response = await launch(parseOpenLinkArguments(args));
  } catch (error) {
    response = error instanceof DaemonUpgradeRequiredError
      ? {
          ok: false,
          error: {
            kind: "upgrade-required",
            message: error.message,
            recoveryAction: error.recoveryAction,
          },
        }
      : {
          ok: false,
          error: {
            kind: "input-unavailable",
            message: error instanceof Error ? error.message : "The Placekeeper link is invalid.",
            recoveryAction: "Open a valid Placekeeper link",
          },
        };
  }
  write(`${JSON.stringify(response)}\n`);
  return response.ok ? 0 : 2;
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
    response = error instanceof DaemonUpgradeRequiredError
      ? {
          ok: false,
          error: {
            kind: "upgrade-required",
            message: error.message,
            recoveryAction: error.recoveryAction,
          },
        }
      : {
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
  if (process.argv[2] === "chrome-registration") {
    return runChromeRegistrationCommand(process.argv.slice(2));
  }
  if (process.argv[2] === "chrome-native-host") {
    return runChromeNativeHostCommand(process.argv.slice(3));
  }
  if (process.argv[2] === "chrome-validate-pdf") {
    return runChromePdfValidationCommand(process.argv.slice(3));
  }
  if (process.argv[2] === "chrome-inspect-pdf") {
    return runChromePdfInspectionCommand(process.argv.slice(3));
  }
  if (process.argv[2] === "open-link") {
    return runOpenLinkCommand(process.argv.slice(2), async (request) =>
      request.operation === "preflight"
        ? preflightLinkThroughDaemon(request.link)
        : openLinkThroughDaemon({
            link: request.link,
            ...(request.confirmed === true ? { confirmed: true } : {}),
            ...(request.recovery === undefined ? {} : { recovery: request.recovery }),
            ...(request.recoveryOffer === undefined ? {} : { recoveryOffer: request.recoveryOffer }),
            ...(request.recoveryOperationId === undefined
              ? {}
              : { recoveryOperationId: request.recoveryOperationId }),
            ...(request.surface === undefined ? {} : { surface: request.surface }),
          }));
  }
  if (process.argv[2] === "hook") {
    return runHookCommand(process.argv.slice(2), await readHookStdin());
  }
  if (process.argv[2] === "context") {
    return runContextCommand(process.argv.slice(2));
  }
  if (process.argv[2] === "doctor") {
    return runDoctorCommand(process.argv.slice(2));
  }
  if (process.argv[2] === "daemon") {
    const args = process.argv.slice(3);
    const paths = pathsForDirectDaemonLaunch(args);
    if (paths === undefined) return runDaemonCommand(args);
    await runServiceDaemon(paths);
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
          message: "The local placekeeper service is unavailable.",
          recoveryAction: "Choose one readable local PDF",
        },
      })}\n`);
      process.exitCode = 2;
    },
  );
}
