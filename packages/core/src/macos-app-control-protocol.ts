export const MACOS_APP_CONTROL_PROTOCOL_VERSION = 1 as const;

const ID = /^[A-Za-z0-9_-]{8,128}$/u;

export type MacosAppControlMessage =
  | {
      readonly protocolVersion: 1;
      readonly type: "register-app";
      readonly appInstanceId: string;
      readonly processId: number;
      readonly startIdentity: string;
      readonly buildIdentity: string;
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

export type MacosAppControlResponse =
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

export function parseMacosAppControlMessage(value: unknown): MacosAppControlMessage | undefined {
  if (!record(value) || value.protocolVersion !== MACOS_APP_CONTROL_PROTOCOL_VERSION || !id(value.appInstanceId)) {
    return undefined;
  }
  if (value.type === "register-app") {
    return exact(value, [
      "protocolVersion", "type", "appInstanceId", "processId", "startIdentity", "buildIdentity",
    ]) && Number.isSafeInteger(value.processId) && (value.processId as number) > 0
      && id(value.startIdentity) && id(value.buildIdentity)
      ? value as unknown as MacosAppControlMessage : undefined;
  }
  if (value.type === "activity") {
    return exact(value, [
      "protocolVersion", "type", "appInstanceId", "activeWindows", "bootstrappingWindows",
    ]) && count(value.activeWindows) && count(value.bootstrappingWindows)
      && value.bootstrappingWindows <= value.activeWindows
      ? value as unknown as MacosAppControlMessage : undefined;
  }
  if (value.type === "prepare-replacement") {
    return exact(value, ["protocolVersion", "type", "appInstanceId"])
      ? value as unknown as MacosAppControlMessage : undefined;
  }
  if (value.type === "detach-helper") {
    return exact(value, ["protocolVersion", "type", "appInstanceId", "helperId"])
      && id(value.helperId)
      ? value as unknown as MacosAppControlMessage : undefined;
  }
  if (value.type === "detach") {
    return exact(value, ["protocolVersion", "type", "appInstanceId", "reason"])
      && ["controlled-exit", "eof", "parent-death"].includes(String(value.reason))
      ? value as unknown as MacosAppControlMessage : undefined;
  }
  return undefined;
}

export function parseMacosAppControlResponse(value: unknown): MacosAppControlResponse | undefined {
  if (!record(value) || value.protocolVersion !== MACOS_APP_CONTROL_PROTOCOL_VERSION || !id(value.appInstanceId)) {
    return undefined;
  }
  if (value.type === "ack" || value.type === "update-required") {
    return exact(value, ["protocolVersion", "type", "appInstanceId"])
      ? value as unknown as MacosAppControlResponse : undefined;
  }
  if (value.type === "replacement-ready") {
    return exact(value, ["protocolVersion", "type", "appInstanceId", "activeWindows"])
      && count(value.activeWindows)
      ? value as unknown as MacosAppControlResponse : undefined;
  }
  if (value.type === "failure") {
    return exact(value, ["protocolVersion", "type", "appInstanceId", "code"])
      && ["invalid", "unregistered", "busy"].includes(String(value.code))
      ? value as unknown as MacosAppControlResponse : undefined;
  }
  return undefined;
}
