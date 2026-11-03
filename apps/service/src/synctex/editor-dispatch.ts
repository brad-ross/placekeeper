import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { decode, encode } from "@msgpack/msgpack";
import { resolveSyncTexSourcePath } from "../files/source-scope.js";
import { validateEditorExecutable, type EditorRegistration } from "./editor-profiles.js";

export type EditorDispatchResult =
  | { readonly status: "opened" }
  | { readonly status: "failed" | "stale"; readonly reason: string };

// Arguments arrive through MessagePack, never through Lua interpolation. Switching
// buffers without force preserves modified buffers and reports refusal to the caller.
const OPEN_SOURCE_LUA = `local path, line, column = ...
local buffer = vim.fn.bufadd(path)
vim.fn.bufload(buffer)
vim.api.nvim_set_current_buf(buffer)
local count = vim.api.nvim_buf_line_count(buffer)
line = math.min(line, count)
local text = vim.api.nvim_buf_get_lines(buffer, line - 1, line, false)[1] or ""
vim.api.nvim_win_set_cursor(0, {line, math.min(column - 1, #text)})
return true`;

function dispatchNeovim(socketPath: string, path: string, line: number, column: number,
  timeoutMs: number, isCurrent: () => boolean): Promise<EditorDispatchResult> {
  return new Promise(resolve => {
    const socket = createConnection(socketPath);
    let bytes = Buffer.alloc(0);
    let done = false;
    const finish = (result: EditorDispatchResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: "failed", reason: "editor-timeout" }), timeoutMs);
    socket.on("error", () => finish({ status: "failed", reason: "neovim-session-unavailable" }));
    socket.on("end", () => finish({ status: "failed", reason: "neovim-session-closed" }));
    socket.on("connect", () => {
      if (!isCurrent()) return finish({ status: "stale", reason: "editor-association-changed" });
      socket.write(encode([0, 1, "nvim_exec_lua", [OPEN_SOURCE_LUA, [path, line, column]]]));
    });
    socket.on("data", chunk => {
      if (bytes.length + chunk.length > 65_536) return finish({ status: "failed", reason: "editor-response-too-large" });
      bytes = Buffer.concat([bytes, chunk]);
      let response: unknown;
      try {
        response = decode(bytes, { maxStrLength: 65_536, maxBinLength: 65_536, maxArrayLength: 64, maxMapLength: 64, maxExtLength: 0 });
      } catch (error) {
        if (error instanceof RangeError && /insufficient|bounds|offset/i.test(error.message)) return;
        return finish({ status: "failed", reason: "invalid-editor-response" });
      }
      if (!Array.isArray(response) || response.length !== 4 || response[0] !== 1 || response[1] !== 1) {
        return finish({ status: "failed", reason: "invalid-editor-response" });
      }
      finish(response[2] === null && response[3] === true
        ? { status: "opened" } : { status: "failed", reason: "neovim-refused-navigation" });
    });
  });
}

export async function dispatchEditorLocation(
  registration: EditorRegistration,
  target: { readonly path: string; readonly line: number; readonly column?: number },
  options: { readonly isCurrent?: () => boolean; readonly timeoutMs?: number } = {},
): Promise<EditorDispatchResult> {
  const isCurrent = options.isCurrent ?? (() => true);
  if (!Number.isSafeInteger(target.line) || target.line < 1 ||
    (target.column !== undefined && (!Number.isSafeInteger(target.column) || target.column < 1))) {
    return { status: "failed", reason: "invalid-source-position" };
  }
  let path: string;
  try { path = (await resolveSyncTexSourcePath(registration.sourceRoot, target.path)).path; }
  catch { return { status: "failed", reason: "source-unavailable" }; }
  const profile = registration.profile;
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (profile.kind === "neovim") {
    if (!isCurrent()) return { status: "stale", reason: "editor-association-changed" };
    if (registration.socket === undefined) return { status: "failed", reason: "neovim-session-unavailable" };
    return dispatchNeovim(registration.socket, path, target.line, target.column ?? 1, timeoutMs, isCurrent);
  }
  try { await validateEditorExecutable(profile.executable); }
  catch { return { status: "failed", reason: "editor-executable-unavailable" }; }
  if (!isCurrent()) return { status: "stale", reason: "editor-association-changed" };
  // A location embedded in an editor's file:line grammar cannot represent colon
  // or newline paths unambiguously. Standalone {file} arguments remain literal.
  if (profile.args.some(arg => arg.includes("{file}") && arg !== "{file}") && /[:\r\n]/u.test(path)) {
    return { status: "failed", reason: "unsupported-editor-location-path" };
  }
  const substitutions: Record<string, string> = { file: path, line: String(target.line), column: String(target.column ?? 1) };
  const args = profile.args.map(arg => arg.replace(/\{(file|line|column)\}/gu, (_, key: string) => substitutions[key]!));
  return new Promise(resolve => {
    const child = spawn(profile.executable, args, { shell: false, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ status: "failed", reason: "editor-timeout" });
    }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); resolve({ status: "failed", reason: "editor-launch-failed" }); });
    child.on("close", code => {
      clearTimeout(timer);
      resolve(code === 0 ? { status: "opened" } : { status: "failed", reason: `editor-exited-${code ?? "signal"}` });
    });
  });
}
