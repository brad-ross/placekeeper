import { resolve } from "node:path";
import { isLocalNeovimPipe, parseEditorControlRequest, type EditorControlRequest, type EditorControlResponse } from "../../../../packages/core/src/editor-navigation-protocol.js";
import { installedSmokeDaemonPaths, INSTALLED_SMOKE_DAEMON_FLAG, INSTALLED_SMOKE_HTTP_PORT_FLAG, INSTALLED_SMOKE_ROOT_FLAG, editorControlThroughDaemon } from "../host/service-daemon.js";

export function parseEditorArguments(args: readonly string[], cwd: string): EditorControlRequest {
  const forward = args[0] === "forward-search";
  if (!forward && args[0] !== "editor") throw new Error("Expected editor or forward-search");
  const command = forward ? "forward" : args[1];
  const options = new Map<string, string>();
  for (let i = forward ? 1 : 2; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (!key.startsWith("--") || value === undefined || options.has(key)) throw new Error(`Invalid or repeated option: ${key}`);
    options.set(key, value);
  }
  const take = (key: string): string | undefined => { const result = options.get(key); options.delete(key); return result; };
  const path = (key: string): string | undefined => { const value = take(key); return value === undefined ? undefined : isLocalNeovimPipe(value) ? value : resolve(cwd, value); };
  let raw: unknown;
  if (command === "preview-fence") raw = { operation: "preview-fence" };
  else if (command === "list") raw = { operation: "profiles" };
  else if (command === "add") {
    const name = take("--name"), adapter = take("--adapter");
    if (adapter !== undefined && adapter !== "neovim") throw new Error("Supported adapter: neovim");
    raw = { operation: "profile-add", profile: adapter === "neovim" ? { name, kind: "neovim" } :
      { name, kind: "command", executable: path("--executable"), args: JSON.parse(take("--args-json") ?? "null") } };
  } else if (command === "register") {
    const profile = take("--profile"), sourceRoot = path("--source-root"), socket = path("--socket");
    raw = { operation: "register", profile, sourceRoot, ...(socket === undefined ? {} : { socket }) };
  } else if (command === "forward") {
    const pdfPath = path("--pdf"), sourcePath = path("--source"), line = Number(take("--line"));
    const column = take("--column"), session = take("--session"), intent = take("--intent") ?? "explicit";
    const association = take("--association"), synctexDirectory = path("--synctex-directory");
    raw = { operation: "forward", pdfPath, sourcePath, line, session, intent,
      ...(column === undefined ? {} : { column: Number(column) }),
      ...(association === undefined ? {} : { association }),
      ...(synctexDirectory === undefined ? {} : { synctexDirectory }) };
  } else throw new Error("Expected editor add, editor list, editor register, editor preview-fence, or forward-search");
  if (options.size > 0) throw new Error(`Unknown option: ${options.keys().next().value}`);
  const request = parseEditorControlRequest(raw);
  if (request === undefined) throw new Error("Invalid editor options: use absolute executable, source/PDF paths, positive line/column, and a registered session");
  return request;
}

export async function runEditorCommand(args: readonly string[], options: {
  readonly cwd?: string;
  readonly exchange?: (request: EditorControlRequest) => Promise<EditorControlResponse>;
  readonly write?: (text: string) => void;
  readonly diagnostic?: (text: string) => void;
} = {}): Promise<number> {
  try {
    const paths = installedSmokeDaemonPaths(args);
    const editorArgs: string[] = [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === INSTALLED_SMOKE_DAEMON_FLAG) continue;
      if (arg === INSTALLED_SMOKE_HTTP_PORT_FLAG || arg === INSTALLED_SMOKE_ROOT_FLAG) { index++; continue; }
      editorArgs.push(arg);
    }
    const request = parseEditorArguments(editorArgs, options.cwd ?? process.cwd());
    const response = await (options.exchange === undefined ? editorControlThroughDaemon(request, paths) : options.exchange(request));
    if (!response.ok) throw new Error(response.message);
    const output = response.operation === "preview-fence" ? response.fence : response.operation === "register" ? response.session : response.operation === "forward" ? response.association : JSON.stringify(response);
    (options.write ?? (text => { process.stdout.write(text); }))(`${output}\n`);
    return 0;
  } catch (error) {
    (options.diagnostic ?? (text => { process.stderr.write(text); }))(`Placekeeper: ${error instanceof Error ? error.message : "Editor command failed"}\n`);
    return 2;
  }
}
