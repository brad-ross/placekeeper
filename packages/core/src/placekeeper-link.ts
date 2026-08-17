export const PLACEKEEPER_LINK_MAX_LENGTH = 16 * 1024;

const PLACEKEEPER_PREFIX = "placekeeper:///";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const ENCODED_SLASH = /%2f/iu;
const PORTABLE_ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type PlacekeeperLinkLocation =
  | { readonly kind: "page"; readonly page: number }
  | { readonly kind: "item"; readonly page: number; readonly itemId: string };

export interface PlacekeeperLinkTarget {
  readonly path: string;
  readonly location: PlacekeeperLinkLocation;
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

function encodeAbsolutePath(path: string): string {
  if (
    !path.startsWith("/") ||
    path === "/" ||
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
  assertPage(target.location.page);
  const item = target.location.kind === "item"
    ? `&item=${(assertPortableItemId(target.location.itemId), target.location.itemId)}`
    : "";
  const link = `${placekeeperLinkBase(target.path)}#v=1&page=${target.location.page}${item}`;
  assertLength(link);
  return link;
}

function decodeCanonicalPath(rawPath: string): string {
  if (!rawPath.startsWith("/") || rawPath === "/" || ENCODED_SLASH.test(rawPath)) {
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

  const fragment = input.slice(hashIndex + 1);
  const match = /^v=1&page=([1-9][0-9]*)(?:&item=([0-9a-f-]+))?$/iu.exec(fragment);
  if (match === null) invalid("Placekeeper link location is malformed or unsupported");
  const page = Number(match[1]);
  assertPage(page);
  const itemId = match[2];
  if (itemId === undefined) return { path, location: { kind: "page", page } };
  assertPortableItemId(itemId);
  return { path, location: { kind: "item", page, itemId } };
}
