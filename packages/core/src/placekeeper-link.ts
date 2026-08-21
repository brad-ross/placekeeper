export const PLACEKEEPER_LINK_MAX_LENGTH = 16 * 1024;

const PLACEKEEPER_PREFIX = "placekeeper:///";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const ENCODED_SEPARATOR = /%(?:2f|5c)/iu;
const PORTABLE_ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const VIEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const DESTINATION_PARAMETER_COUNTS = {
  "xyz": 3,
  "fit-page": 0,
  "fit-bounding-box": 0,
  "fit-horizontal": 1,
  "fit-vertical": 1,
  "fit-bounding-box-horizontal": 1,
  "fit-bounding-box-vertical": 1,
  "fit-rectangle": 4,
} as const;

export type PlacekeeperPdfDestinationMode = keyof typeof DESTINATION_PARAMETER_COUNTS;

export interface PlacekeeperPdfDestinationLocation {
  readonly kind: "destination";
  /** One-based coarse fallback page. */
  readonly page: number;
  readonly mode: PlacekeeperPdfDestinationMode;
  readonly params: readonly number[];
}

export type PlacekeeperLinkLocation =
  | { readonly kind: "page"; readonly page: number }
  | { readonly kind: "item"; readonly page: number; readonly itemId: string }
  | PlacekeeperPdfDestinationLocation;

export interface PlacekeeperLinkTarget {
  readonly path: string;
  readonly location: PlacekeeperLinkLocation;
}

export interface PlacekeeperReadableViewRoute {
  readonly viewId: string;
  readonly path: string;
}

export class PlacekeeperLinkError extends Error {
  readonly code: "INVALID_LINK" | "LINK_TOO_LONG";

  constructor(code: PlacekeeperLinkError["code"], message: string) {
    super(message);
    this.name = "PlacekeeperLinkError";
    this.code = code;
  }
}

function invalid(message: string): never {
  throw new PlacekeeperLinkError("INVALID_LINK", message);
}

function assertLength(value: string): void {
  if (value.length > PLACEKEEPER_LINK_MAX_LENGTH) {
    throw new PlacekeeperLinkError("LINK_TOO_LONG", "Placekeeper link exceeds the length limit");
  }
}

function assertPage(page: number): void {
  if (!Number.isSafeInteger(page) || page < 1) {
    invalid("Placekeeper link page must be a one-based safe integer");
  }
}

function assertPortableItemId(itemId: string): void {
  if (!PORTABLE_ITEM_ID.test(itemId)) {
    invalid("Placekeeper link item must be a portable Placekeeper item ID");
  }
}

function destinationParameterCount(mode: unknown): number {
  if (
    typeof mode !== "string" ||
    !Object.prototype.hasOwnProperty.call(DESTINATION_PARAMETER_COUNTS, mode)
  ) {
    return invalid("Placekeeper link destination mode is unsupported");
  }
  return DESTINATION_PARAMETER_COUNTS[mode as PlacekeeperPdfDestinationMode];
}

function encodeDestinationParameter(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
    return invalid("Placekeeper link destination parameters must be finite canonical numbers");
  }
  return String(value);
}

function decodeDestinationParameter(value: string): number {
  const decoded = Number(value);
  if (
    value.length === 0 ||
    !Number.isFinite(decoded) ||
    Object.is(decoded, -0) ||
    String(decoded) !== value
  ) {
    return invalid("Placekeeper link destination parameter is not canonical");
  }
  return decoded;
}

function encodeDestination(location: PlacekeeperPdfDestinationLocation): string {
  const parameterCount = destinationParameterCount(location.mode);
  if (!Array.isArray(location.params) || location.params.length !== parameterCount) {
    return invalid("Placekeeper link destination has the wrong parameter count");
  }
  if (parameterCount === 0) return `v=2&page=${location.page}&mode=${location.mode}`;
  const params = location.params.map(encodeDestinationParameter).join(",");
  return `v=2&page=${location.page}&mode=${location.mode}&params=${params}`;
}

function encodeAbsolutePath(path: string): string {
  if (
    !path.startsWith("/") ||
    path === "/" ||
    path.includes("\\") ||
    CONTROL_CHARACTERS.test(path) ||
    !path.toLowerCase().endsWith(".pdf")
  ) {
    invalid("Placekeeper links require an absolute PDF path");
  }
  const segments = path.split("/");
  if (segments.slice(1).some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    invalid("Placekeeper link path must be canonical");
  }
  try {
    return segments.map((segment, index) => index === 0 ? "" : encodeURIComponent(segment)).join("/");
  } catch {
    return invalid("Placekeeper link path contains invalid Unicode");
  }
}

export function placekeeperLinkBase(path: string): string {
  const base = `placekeeper://${encodeAbsolutePath(path)}`;
  assertLength(base);
  return base;
}

export function encodePlacekeeperLink(target: PlacekeeperLinkTarget): string {
  const link = `${placekeeperLinkBase(target.path)}#${encodePlacekeeperLinkFragment(target.location)}`;
  assertLength(link);
  return link;
}

export function encodePlacekeeperLinkFragment(location: PlacekeeperLinkLocation): string {
  assertPage(location.page);
  if (location.kind === "destination") return encodeDestination(location);
  const item = location.kind === "item"
    ? `&item=${(assertPortableItemId(location.itemId), location.itemId)}`
    : "";
  return `v=1&page=${location.page}${item}`;
}

function decodeCanonicalPath(rawPath: string): string {
  if (!rawPath.startsWith("/") || rawPath === "/" || ENCODED_SEPARATOR.test(rawPath)) {
    invalid("Placekeeper link path is not canonical");
  }
  let path: string;
  try {
    path = rawPath.split("/").map((segment, index) => index === 0 ? "" : decodeURIComponent(segment)).join("/");
  } catch {
    return invalid("Placekeeper link path has malformed encoding");
  }
  if (CONTROL_CHARACTERS.test(path) || encodeAbsolutePath(path) !== rawPath) {
    invalid("Placekeeper link path is not canonically encoded");
  }
  return path;
}

export function decodePlacekeeperLinkFragment(fragment: string): PlacekeeperLinkLocation {
  assertLength(fragment);
  if (CONTROL_CHARACTERS.test(fragment) || fragment.startsWith("#")) {
    invalid("Placekeeper link location must not include a fragment marker");
  }
  const v1Match = /^v=1&page=([1-9][0-9]*)(?:&item=([0-9a-f-]+))?$/u.exec(fragment);
  if (v1Match !== null) {
    const page = Number(v1Match[1]);
    assertPage(page);
    const itemId = v1Match[2];
    if (itemId === undefined) return { kind: "page", page };
    assertPortableItemId(itemId);
    return { kind: "item", page, itemId };
  }

  const v2Match = /^v=2&page=([1-9][0-9]*)&mode=([a-z-]+)(?:&params=([^&]+))?$/u.exec(fragment);
  if (v2Match === null) invalid("Placekeeper link location is malformed or unsupported");
  const page = Number(v2Match[1]);
  assertPage(page);
  const mode = v2Match[2]!;
  const parameterCount = destinationParameterCount(mode);
  const rawParams = v2Match[3];
  const params = rawParams === undefined ? [] : rawParams.split(",").map(decodeDestinationParameter);
  if (params.length !== parameterCount) {
    invalid("Placekeeper link destination has the wrong parameter count");
  }
  return {
    kind: "destination",
    page,
    mode: mode as PlacekeeperPdfDestinationMode,
    params,
  };
}

export function encodePlacekeeperReadableViewPathname(
  route: PlacekeeperReadableViewRoute,
): string {
  if (!VIEW_ID.test(route.viewId)) invalid("Placekeeper readable view ID is invalid");
  const pathname = `/r/${route.viewId}${encodeAbsolutePath(route.path)}`;
  assertLength(pathname);
  return pathname;
}

export function decodePlacekeeperReadableViewPathname(
  pathname: string,
): PlacekeeperReadableViewRoute {
  assertLength(pathname);
  if (CONTROL_CHARACTERS.test(pathname) || pathname.includes("?") || pathname.includes("#")) {
    invalid("Placekeeper readable view route is malformed");
  }
  const match = /^\/r\/([0-9a-f-]{36})(\/.*)$/u.exec(pathname);
  if (match === null || !VIEW_ID.test(match[1]!)) {
    invalid("Placekeeper readable view route is malformed");
  }
  const path = decodeCanonicalPath(match[2]!);
  const route = { viewId: match[1]!, path };
  if (encodePlacekeeperReadableViewPathname(route) !== pathname) {
    invalid("Placekeeper readable view route is not canonical");
  }
  return route;
}

export function decodePlacekeeperLink(input: string): PlacekeeperLinkTarget {
  assertLength(input);
  if (CONTROL_CHARACTERS.test(input) || !input.startsWith(PLACEKEEPER_PREFIX)) {
    invalid("Placekeeper link must use the canonical triple-slash form");
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return invalid("Placekeeper link is malformed");
  }
  if (
    parsed.protocol !== "placekeeper:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.host !== "" ||
    parsed.port !== "" ||
    parsed.search !== ""
  ) {
    invalid("Placekeeper link authority and query must be empty");
  }

  const hashIndex = input.indexOf("#");
  if (hashIndex < PLACEKEEPER_PREFIX.length) invalid("Placekeeper link location is missing");
  const rawPath = input.slice("placekeeper://".length, hashIndex);
  if (parsed.pathname !== rawPath) invalid("Placekeeper link path is not canonical");
  const path = decodeCanonicalPath(rawPath);

  return { path, location: decodePlacekeeperLinkFragment(input.slice(hashIndex + 1)) };
}
