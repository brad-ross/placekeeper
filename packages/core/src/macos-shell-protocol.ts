export const MACOS_SHELL_PROTOCOL_VERSION = 1 as const;

const OPAQUE_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const MANIFEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface MacosRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type MacosPageMessage =
  | {
    readonly protocolVersion: 1;
    readonly type: "shell-ready";
    readonly layoutRevision: number;
  }
  | {
    readonly protocolVersion: 1;
    readonly type: "visible-shell-ready";
    readonly layoutRevision: number;
    readonly geometryIdentity: string;
    readonly frameSequence: number;
  }
  | {
    readonly protocolVersion: 1;
    readonly type: "drag-regions";
    readonly layoutRevision: number;
    readonly geometryIdentity: string;
    readonly regions: readonly MacosRect[];
  };

export interface MacosDocumentResource {
  readonly url: string;
  readonly generation: number;
  readonly mime: "application/pdf";
  readonly byteLength: number;
  readonly digest: string;
}

export type MacosNativeMessage =
  | {
    readonly protocolVersion: 1;
    readonly type: "bootstrap";
    readonly document: {
      readonly displayName: string;
      readonly resource: MacosDocumentResource;
    };
    readonly geometry: {
      readonly identity: string;
      readonly trafficLightInset: number;
      readonly trailingInset: number;
    };
  }
  | {
    readonly protocolVersion: 1;
    readonly type: "commit-visible";
    readonly geometryIdentity: string;
  }
  | {
    readonly protocolVersion: 1;
    readonly type: "geometry-changed";
    readonly geometry: {
      readonly identity: string;
      readonly trafficLightInset: number;
      readonly trailingInset: number;
    };
  }
  | {
    readonly protocolVersion: 1;
    readonly type: "fatal-error";
    readonly code: "shell-unavailable" | "helper-unavailable" | "resource-invalid";
  };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function safeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function safeFinite(value: unknown, maximum = 100_000): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
}

function opaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function rect(value: unknown): value is MacosRect {
  return record(value) && exact(value, ["x", "y", "width", "height"])
    && safeFinite(value.x) && safeFinite(value.y)
    && safeFinite(value.width) && value.width > 0
    && safeFinite(value.height) && value.height > 0;
}

export function parseMacosPageMessage(value: unknown): MacosPageMessage | undefined {
  if (!record(value) || value.protocolVersion !== MACOS_SHELL_PROTOCOL_VERSION) return undefined;
  if (value.type === "shell-ready") {
    return exact(value, ["protocolVersion", "type", "layoutRevision"])
      && safeInteger(value.layoutRevision) ? value as unknown as MacosPageMessage : undefined;
  }
  if (value.type === "visible-shell-ready") {
    return exact(value, [
      "protocolVersion", "type", "layoutRevision", "geometryIdentity", "frameSequence",
    ]) && safeInteger(value.layoutRevision) && opaqueId(value.geometryIdentity)
      && safeInteger(value.frameSequence) && value.frameSequence > 0
      ? value as unknown as MacosPageMessage : undefined;
  }
  if (value.type === "drag-regions") {
    return exact(value, [
      "protocolVersion", "type", "layoutRevision", "geometryIdentity", "regions",
    ]) && safeInteger(value.layoutRevision) && opaqueId(value.geometryIdentity)
      && Array.isArray(value.regions) && value.regions.length <= 32 && value.regions.every(rect)
      ? value as unknown as MacosPageMessage : undefined;
  }
  return undefined;
}

function safeDisplayName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255
    && !/[\u0000-\u001f/\\]/u.test(value);
}

export function parseMacosBundleURL(value: unknown): { readonly manifestKey: string } | undefined {
  if (typeof value !== "string" || value.length > 512 || /(?:^|[/\\])\.\.(?:[/\\]|$)|%2e|%2f|%5c/iu.test(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "placekeeper-app:" || url.hostname !== "bundle" || url.username !== ""
      || url.password !== "" || url.port !== "" || url.search !== "" || url.hash !== "") return undefined;
    const manifestKey = decodeURIComponent(url.pathname.replace(/^\//u, ""));
    if (!MANIFEST_KEY.test(manifestKey) || manifestKey.includes("//") || manifestKey.split("/").includes("..")) {
      return undefined;
    }
    return { manifestKey };
  } catch {
    return undefined;
  }
}

export function parseMacosResourceURL(value: unknown): {
  readonly resourceId: string;
  readonly generation: number;
  readonly role: "document";
} | undefined {
  if (typeof value !== "string" || value.length > 512 || /%2f|%5c/iu.test(value)) return undefined;
  try {
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    const generationText = url.searchParams.get("generation");
    const generation = generationText === null || !/^[1-9]\d{0,8}$/u.test(generationText)
      ? undefined : Number(generationText);
    const resourceId = decodeURIComponent(url.pathname.replace(/^\//u, ""));
    if (url.protocol !== "placekeeper-resource:" || url.hostname !== "document"
      || url.username !== "" || url.password !== "" || url.port !== "" || url.hash !== ""
      || keys.length !== 2 || keys[0] !== "generation" || keys[1] !== "role"
      || url.searchParams.get("role") !== "document" || generation === undefined
      || !opaqueId(resourceId)) return undefined;
    return { resourceId, generation, role: "document" };
  } catch {
    return undefined;
  }
}

export function parseMacosNativeMessage(value: unknown): MacosNativeMessage | undefined {
  if (!record(value) || value.protocolVersion !== MACOS_SHELL_PROTOCOL_VERSION) return undefined;
  if (value.type === "commit-visible") {
    return exact(value, ["protocolVersion", "type", "geometryIdentity"])
      && opaqueId(value.geometryIdentity) ? value as unknown as MacosNativeMessage : undefined;
  }
  if (value.type === "geometry-changed") {
    return exact(value, ["protocolVersion", "type", "geometry"]) && record(value.geometry)
      && exact(value.geometry, ["identity", "trafficLightInset", "trailingInset"])
      && opaqueId(value.geometry.identity) && safeFinite(value.geometry.trafficLightInset, 1_000)
      && safeFinite(value.geometry.trailingInset, 1_000)
      ? value as unknown as MacosNativeMessage : undefined;
  }
  if (value.type === "fatal-error") {
    return exact(value, ["protocolVersion", "type", "code"])
      && ["shell-unavailable", "helper-unavailable", "resource-invalid"].includes(String(value.code))
      ? value as unknown as MacosNativeMessage : undefined;
  }
  if (value.type !== "bootstrap" || !exact(value, [
    "protocolVersion", "type", "document", "geometry",
  ]) || !record(value.document) || !record(value.geometry)) return undefined;
  const resource = value.document.resource;
  if (!exact(value.document, ["displayName", "resource"]) || !safeDisplayName(value.document.displayName)
    || !record(resource) || !exact(resource, ["url", "generation", "mime", "byteLength", "digest"])
    || resource.mime !== "application/pdf" || !safeInteger(resource.generation) || resource.generation < 1
    || !safeInteger(resource.byteLength, 512 * 1024 * 1024) || resource.byteLength < 5
    || typeof resource.digest !== "string" || !SHA256.test(resource.digest)) return undefined;
  const parsedResource = parseMacosResourceURL(resource.url);
  if (parsedResource === undefined || parsedResource.generation !== resource.generation
    || !exact(value.geometry, ["identity", "trafficLightInset", "trailingInset"])
    || !opaqueId(value.geometry.identity) || !safeFinite(value.geometry.trafficLightInset, 1_000)
    || !safeFinite(value.geometry.trailingInset, 1_000)) return undefined;
  return value as unknown as MacosNativeMessage;
}
