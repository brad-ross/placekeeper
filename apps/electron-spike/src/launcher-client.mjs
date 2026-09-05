import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

import {
  launchResultUrl,
  launcherArguments,
  linkOpenArguments,
  linkPreflightArguments,
} from "./launch-policy.mjs";

const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = Object.freeze({
  encoding: "utf8",
  maxBuffer: 65_536,
  timeout: 15_000,
  windowsHide: true,
});
const SERVICE_ERROR_KINDS = new Set([
  "input-unavailable",
  "unsupported-context",
  "upgrade-required",
]);

function parseResponse(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("Placekeeper returned invalid JSON");
  }
}

function isServiceFailureResponse(result) {
  return (
    result?.ok === false &&
    SERVICE_ERROR_KINDS.has(result.error?.kind) &&
    typeof result.error.message === "string" &&
    typeof result.error.recoveryAction === "string"
  );
}

function responseError(result) {
  if (isServiceFailureResponse(result)) {
    return new Error(result.error.message);
  }
  return undefined;
}

function structuredFailureFromOrdinaryExit(error) {
  if (
    error === null ||
    typeof error !== "object" ||
    !Number.isInteger(error.code) ||
    error.code <= 0 ||
    error.killed === true ||
    (error.signal !== undefined && error.signal !== null) ||
    typeof error.stdout !== "string" ||
    error.stdout.length === 0 ||
    Buffer.byteLength(error.stdout, "utf8") > EXEC_OPTIONS.maxBuffer
  ) {
    return undefined;
  }

  let result;
  try {
    result = JSON.parse(error.stdout);
  } catch {
    return undefined;
  }
  return isServiceFailureResponse(result) ? result : undefined;
}

async function invoke({ args, exec = execFileAsync, launcherPath }) {
  if (!isAbsolute(launcherPath)) throw new Error("The installed launcher path must be absolute");
  try {
    const { stdout } = await exec(launcherPath, args, EXEC_OPTIONS);
    return parseResponse(stdout);
  } catch (error) {
    const result = structuredFailureFromOrdinaryExit(error);
    if (result !== undefined) return result;
    throw error;
  }
}

function linkedPdfPath(value, responseKind) {
  if (typeof value !== "string" || !isAbsolute(value) || !value.toLowerCase().endsWith(".pdf")) {
    throw new Error(`Invalid Placekeeper ${responseKind} response`);
  }
  return value;
}

function openedUrl(result) {
  const failure = responseError(result);
  if (failure !== undefined) throw failure;
  if (result?.kind === "recovery-offered") {
    throw new Error("Protected Recovery is outside this Electron shell spike");
  }
  if (result?.kind === "confirmation-required") {
    throw new Error("The Placekeeper link requires confirmation");
  }
  return launchResultUrl(result);
}

export async function launchPdf(options) {
  const result = await invoke({
    ...options,
    args: launcherArguments(options.pdfPath),
  });
  return openedUrl(result);
}

export async function preflightPlacekeeperLink(options) {
  const result = await invoke({
    ...options,
    args: linkPreflightArguments(options.link),
  });
  const failure = responseError(result);
  if (failure !== undefined) throw failure;
  if (
    result?.ok !== true ||
    result.kind !== "link-preflight" ||
    typeof result.confirmationRequired !== "boolean"
  ) {
    throw new Error("Invalid Placekeeper link preflight response");
  }
  return {
    path: linkedPdfPath(result.path, "link preflight"),
    confirmationRequired: result.confirmationRequired,
  };
}

export async function openPlacekeeperLink(options) {
  const result = await invoke({
    ...options,
    args: linkOpenArguments(options.link, options.confirmed),
  });
  const failure = responseError(result);
  if (failure !== undefined) throw failure;
  if (result?.kind === "recovery-offered") {
    throw new Error("Protected Recovery is outside this Electron shell spike");
  }
  if (result?.ok === true && result.kind === "confirmation-required") {
    return {
      kind: "confirmation-required",
      path: linkedPdfPath(result.path, "link confirmation"),
    };
  }
  return openedUrl(result);
}
