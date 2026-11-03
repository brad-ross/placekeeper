export type EditorProfile =
  | { readonly name: string; readonly kind: "command"; readonly executable: string; readonly args: readonly string[] }
  | { readonly name: string; readonly kind: "neovim" };

export interface EditorRegistrationRequest {
  readonly profile: string;
  readonly sourceRoot: string;
  readonly socket?: string;
}

export interface EditorForwardRequest {
  readonly operation: "forward";
  readonly pdfPath: string;
  readonly sourcePath: string;
  readonly line: number;
  readonly column?: number;
  readonly session: string;
  readonly intent: "explicit" | "follow" | "preview";
  readonly association?: string;
  readonly synctexDirectory?: string;
}

export type EditorControlRequest =
  | { readonly operation: "profile-add"; readonly profile: EditorProfile }
  | { readonly operation: "preview-fence" }
  | { readonly operation: "profiles" }
  | ({ readonly operation: "register" } & EditorRegistrationRequest)
  | EditorForwardRequest;

export type EditorControlResponse =
  | { readonly ok: true; readonly operation: "preview-fence"; readonly fence: string }
  | { readonly ok: true; readonly operation: "profile-add" }
  | { readonly ok: true; readonly operation: "profiles"; readonly profiles: readonly { readonly name: string; readonly kind: EditorProfile["kind"] }[] }
  | { readonly ok: true; readonly operation: "register"; readonly session: string }
  | { readonly ok: true; readonly operation: "forward"; readonly ticket: string; readonly association: string }
  | { readonly ok: false; readonly message: string };

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
export function isEditorPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 16_384 && !value.includes("\0");
}
export function isEditorToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}
function coordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function parseEditorProfile(value: unknown): EditorProfile | undefined {
  if (!record(value) || typeof value.name !== "string" || !NAME.test(value.name)) return undefined;
  if (value.kind === "neovim" && keys(value, ["name", "kind"])) return { name: value.name, kind: "neovim" };
  if (value.kind !== "command" || !keys(value, ["name", "kind", "executable", "args"]) ||
    !isEditorPath(value.executable) || !Array.isArray(value.args) || value.args.length > 64) return undefined;
  const args: string[] = [];
  for (const arg of value.args) {
    if (typeof arg !== "string" || arg.length > 16_384 || arg.includes("\0") ||
      /[{}]/u.test(arg.replace(/\{(?:file|line|column)\}/gu, ""))) return undefined;
    args.push(arg);
  }
  if (!args.some(arg => arg.includes("{file}"))) return undefined;
  return { name: value.name, kind: "command", executable: value.executable, args };
}

export function parseEditorControlRequest(value: unknown): EditorControlRequest | undefined {
  if (!record(value)) return undefined;
  if (value.operation === "preview-fence" && keys(value, ["operation"])) return { operation: "preview-fence" };
  if (value.operation === "profiles" && keys(value, ["operation"])) return { operation: "profiles" };
  if (value.operation === "profile-add" && keys(value, ["operation", "profile"])) {
    const profile = parseEditorProfile(value.profile);
    return profile === undefined ? undefined : { operation: "profile-add", profile };
  }
  if (value.operation === "register" && keys(value, ["operation", "profile", "sourceRoot", "socket"]) &&
    typeof value.profile === "string" && NAME.test(value.profile) && isEditorPath(value.sourceRoot) &&
    (value.socket === undefined || isEditorPath(value.socket))) {
    return { operation: "register", profile: value.profile, sourceRoot: value.sourceRoot,
      ...(value.socket === undefined ? {} : { socket: value.socket }) };
  }
  if (value.operation !== "forward" || !keys(value, ["operation", "pdfPath", "sourcePath", "line", "column", "session", "intent", "association", "synctexDirectory"]) ||
    !isEditorPath(value.pdfPath) || !isEditorPath(value.sourcePath) || !coordinate(value.line) ||
    (value.column !== undefined && !coordinate(value.column)) || !isEditorToken(value.session) ||
    (value.intent !== "explicit" && value.intent !== "follow" && value.intent !== "preview") ||
    (value.association !== undefined && !isEditorToken(value.association)) ||
    (value.intent !== "explicit" && value.association === undefined) ||
    (value.synctexDirectory !== undefined && !isEditorPath(value.synctexDirectory))) return undefined;
  return { operation: "forward", pdfPath: value.pdfPath, sourcePath: value.sourcePath, line: value.line,
    session: value.session, intent: value.intent,
    ...(value.column === undefined ? {} : { column: value.column }),
    ...(value.association === undefined ? {} : { association: value.association }),
    ...(value.synctexDirectory === undefined ? {} : { synctexDirectory: value.synctexDirectory }) };
}
