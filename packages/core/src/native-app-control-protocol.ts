import { isEditorEndpoint, isEditorPath, isEditorToken } from "./editor-navigation-protocol.js";
export const NATIVE_APP_CONTROL_PROTOCOL_VERSION = 1 as const;

const ID = /^[A-Za-z0-9_-]{8,128}$/u;

export type NativeAppControlMessage =
  | { readonly protocolVersion: 1; readonly type: "editor-profiles"; readonly appInstanceId: string }
  | { readonly protocolVersion: 1; readonly type: "associate-editor"; readonly appInstanceId: string; readonly helperId: string;
      readonly profile: string; readonly sourceRoot: string; readonly socket?: string }
  | { readonly protocolVersion: 1; readonly type: "bind-navigation"; readonly appInstanceId: string; readonly helperId: string; readonly navigationHandle: string }
  | { readonly protocolVersion: 1; readonly type: "redeem-navigation"; readonly appInstanceId: string; readonly ticket: string }
  | {
      readonly protocolVersion: 1;
      readonly type: "register-app";
      readonly appInstanceId: string;
      readonly processId: number;
      readonly startIdentity: string;
      readonly buildIdentity: string;
      readonly installationIdentity?: string;
    }
  | {
      readonly protocolVersion: 1;
      readonly type: "activity";
      readonly appInstanceId: string;
      readonly activeWindows: number;
      readonly bootstrappingWindows: number;
    }
  | {
      readonly protocolVersion: 1;
      readonly type: "prepare-replacement";
      readonly appInstanceId: string;
    }
  | {
      readonly protocolVersion: 1;
      readonly type: "detach-helper";
      readonly appInstanceId: string;
      readonly helperId: string;
    }
  | {
      readonly protocolVersion: 1;
      readonly type: "detach";
      readonly appInstanceId: string;
      readonly reason: "controlled-exit" | "eof" | "parent-death";
    };

export type NativeAppControlResponse =
  | { readonly protocolVersion: 1; readonly type: "editor-profiles"; readonly appInstanceId: string;
      readonly profiles: readonly { readonly name: string; readonly kind: "command" | "neovim" }[] }
  | { readonly protocolVersion: 1; readonly type: "navigation"; readonly appInstanceId: string; readonly pdfPath: string; readonly navigationHandle: string }
  | { readonly protocolVersion: 1; readonly type: "navigation-unavailable"; readonly appInstanceId: string }
  | {
      readonly protocolVersion: 1;
      readonly type: "ack";
      readonly appInstanceId: string;
    }
  | {
      readonly protocolVersion: 1;
      readonly type: "replacement-ready";
      readonly appInstanceId: string;
      readonly activeWindows: number;
    }
  | {
      readonly protocolVersion: 1;
      readonly type: "update-required";
      readonly appInstanceId: string;
    }
  | {
      readonly protocolVersion: 1;
      readonly type: "failure";
      readonly appInstanceId: string;
      readonly code: "invalid" | "unregistered" | "busy";
    };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function id(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 64;
}

export function parseNativeAppControlMessage(value: unknown): NativeAppControlMessage | undefined {
  if (!record(value) || value.protocolVersion !== NATIVE_APP_CONTROL_PROTOCOL_VERSION || !id(value.appInstanceId)) {
    return undefined;
  }
  if (value.type === "editor-profiles") return exact(value, ["protocolVersion", "type", "appInstanceId"])
    ? value as unknown as NativeAppControlMessage : undefined;
  if (value.type === "associate-editor") return exact(value, ["protocolVersion", "type", "appInstanceId", "helperId", "profile", "sourceRoot",
    ...(value.socket === undefined ? [] : ["socket"])]) && id(value.helperId) && typeof value.profile === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value.profile)
    && isEditorPath(value.sourceRoot) && (value.socket === undefined || isEditorEndpoint(value.socket)) ? value as unknown as NativeAppControlMessage : undefined;
  if (value.type === "bind-navigation") return exact(value, ["protocolVersion", "type", "appInstanceId", "helperId", "navigationHandle"])
    && id(value.helperId) && isEditorToken(value.navigationHandle) ? value as unknown as NativeAppControlMessage : undefined;
  if (value.type === "redeem-navigation") return exact(value, ["protocolVersion", "type", "appInstanceId", "ticket"]) && isEditorToken(value.ticket)
    ? value as unknown as NativeAppControlMessage : undefined;
  if (value.type === "register-app") {
    return exact(value, [
      "protocolVersion", "type", "appInstanceId", "processId", "startIdentity", "buildIdentity",
      ...(value.installationIdentity === undefined ? [] : ["installationIdentity"]),
    ]) && Number.isSafeInteger(value.processId) && (value.processId as number) > 0
      && id(value.startIdentity) && id(value.buildIdentity)
      && (value.installationIdentity === undefined || (typeof value.installationIdentity === "string" && /^(?:[a-f0-9]{64}|development)$/u.test(value.installationIdentity)))
      ? value as unknown as NativeAppControlMessage : undefined;
  }
  if (value.type === "activity") {
    return exact(value, [
      "protocolVersion", "type", "appInstanceId", "activeWindows", "bootstrappingWindows",
    ]) && count(value.activeWindows) && count(value.bootstrappingWindows)
      && value.bootstrappingWindows <= value.activeWindows
      ? value as unknown as NativeAppControlMessage : undefined;
  }
  if (value.type === "prepare-replacement") {
    return exact(value, ["protocolVersion", "type", "appInstanceId"])
      ? value as unknown as NativeAppControlMessage : undefined;
  }
  if (value.type === "detach-helper") {
    return exact(value, ["protocolVersion", "type", "appInstanceId", "helperId"])
      && id(value.helperId)
      ? value as unknown as NativeAppControlMessage : undefined;
  }
  if (value.type === "detach") {
    return exact(value, ["protocolVersion", "type", "appInstanceId", "reason"])
      && ["controlled-exit", "eof", "parent-death"].includes(String(value.reason))
      ? value as unknown as NativeAppControlMessage : undefined;
  }
  return undefined;
}

export function parseNativeAppControlResponse(value: unknown): NativeAppControlResponse | undefined {
  if (!record(value) || value.protocolVersion !== NATIVE_APP_CONTROL_PROTOCOL_VERSION || !id(value.appInstanceId)) {
    return undefined;
  }
  if (value.type === "editor-profiles") return exact(value, ["protocolVersion", "type", "appInstanceId", "profiles"]) &&
    Array.isArray(value.profiles) && value.profiles.every(profile => record(profile) && exact(profile, ["name", "kind"]) &&
      typeof profile.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(profile.name) && ["command", "neovim"].includes(String(profile.kind)))
    ? value as unknown as NativeAppControlResponse : undefined;
  if (value.type === "navigation") return exact(value, ["protocolVersion", "type", "appInstanceId", "pdfPath", "navigationHandle"])
    && isEditorPath(value.pdfPath) && isEditorToken(value.navigationHandle) ? value as unknown as NativeAppControlResponse : undefined;
  if (value.type === "ack" || value.type === "update-required" || value.type === "navigation-unavailable") {
    return exact(value, ["protocolVersion", "type", "appInstanceId"])
      ? value as unknown as NativeAppControlResponse : undefined;
  }
  if (value.type === "replacement-ready") {
    return exact(value, ["protocolVersion", "type", "appInstanceId", "activeWindows"])
      && count(value.activeWindows)
      ? value as unknown as NativeAppControlResponse : undefined;
  }
  if (value.type === "failure") {
    return exact(value, ["protocolVersion", "type", "appInstanceId", "code"])
      && ["invalid", "unregistered", "busy"].includes(String(value.code))
      ? value as unknown as NativeAppControlResponse : undefined;
  }
  return undefined;
}
