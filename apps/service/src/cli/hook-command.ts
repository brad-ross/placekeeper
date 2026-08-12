import { isAbsolute } from "node:path";

import { parseOpenArguments } from "./open-command.js";

const MAX_HOOK_INPUT_BYTES = 128 * 1024;
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,256}$/u;
const REVIEW_IDENTIFIER = /^[A-Za-z0-9_-]{1,256}$/u;

interface JsonObject {
  readonly [key: string]: unknown;
}

export type HookContractEvent =
  | {
      readonly kind: "launch-correlated";
      readonly taskSessionId: string;
      readonly reviewSessionId: string;
    }
  | {
      readonly kind: "prompt-context-supported";
      readonly taskSessionId: string;
    }
  | { readonly kind: "ignored" };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function taskIdentity(event: JsonObject): string | undefined {
  return typeof event.session_id === "string" && IDENTIFIER.test(event.session_id) &&
    typeof event.turn_id === "string" && IDENTIFIER.test(event.turn_id)
    ? event.session_id
    : undefined;
}

/**
 * Tokenizes one deliberately narrow shell command. Control operators,
 * substitutions, newlines, and unterminated quotes fail closed instead of
 * trying to reproduce shell parsing inside a lifecycle hook.
 */
function tokenizeSimpleCommand(command: string): readonly string[] | undefined {
  if (command.length === 0 || command.length > 16_384) return undefined;
  const tokens: string[] = [];
  let token = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;
  let tokenStarted = false;

  for (const character of command) {
    if (escaped) {
      token += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (quote !== "single" && character === "\\") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote === "single") {
      if (character === "'") quote = undefined;
      else token += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = undefined;
      else if (character === "$" || character === "`" || character === "\n" || character === "\r") return undefined;
      else token += character;
      continue;
    }
    if (character === "'") {
      quote = "single";
      tokenStarted = true;
      continue;
    }
    if (character === '"') {
      quote = "double";
      tokenStarted = true;
      continue;
    }
    if (";&|<>$`()".includes(character) || character === "\n" || character === "\r") return undefined;
    if (/\s/u.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    token += character;
    tokenStarted = true;
  }
  if (escaped || quote !== undefined) return undefined;
  if (tokenStarted) tokens.push(token);
  return tokens;
}

function isCodexOpenCommand(value: unknown): boolean {
  if (!isObject(value) || typeof value.command !== "string") return false;
  const tokens = tokenizeSimpleCommand(value.command);
  if (tokens === undefined || tokens[0] !== "pdf-proofreader") return false;
  try {
    const request = parseOpenArguments(tokens.slice(1));
    return request.surface === "codex" && isAbsolute(request.pdfPath);
  } catch {
    return false;
  }
}

function launchResponse(value: unknown): { readonly reviewSessionId: string } | undefined {
  if (!isObject(value) || value.exit_code !== 0 || typeof value.output !== "string") return undefined;
  const serialized = value.output.trim();
  if (serialized.length === 0 || serialized.length > 65_536) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isObject(parsed) || parsed.ok !== true ||
    (parsed.kind !== "opened" && parsed.kind !== "focused") ||
    typeof parsed.sessionId !== "string" || !REVIEW_IDENTIFIER.test(parsed.sessionId) ||
    typeof parsed.url !== "string"
  ) return undefined;

  try {
    const url = new URL(parsed.url);
    if (
      url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
      url.port.length === 0 || url.username.length > 0 || url.password.length > 0 ||
      url.search.length > 0 ||
      url.pathname !== `/s/${parsed.sessionId}/bootstrap` ||
      !/^#cap=[A-Za-z0-9_-]+$/u.test(url.hash)
    ) return undefined;
  } catch {
    return undefined;
  }
  return { reviewSessionId: parsed.sessionId };
}

/** Inspects documented hook fields only; transcripts and ambient UI state are never read. */
export function inspectHookEvent(value: unknown): HookContractEvent {
  if (!isObject(value)) return { kind: "ignored" };
  const taskSessionId = taskIdentity(value);
  if (taskSessionId === undefined) return { kind: "ignored" };

  if (value.hook_event_name === "PostToolUse") {
    if (value.tool_name !== "Bash" || !isCodexOpenCommand(value.tool_input)) {
      return { kind: "ignored" };
    }
    const response = launchResponse(value.tool_response);
    return response === undefined
      ? { kind: "ignored" }
      : {
          kind: "launch-correlated",
          taskSessionId,
          reviewSessionId: response.reviewSessionId,
        };
  }

  if (value.hook_event_name === "UserPromptSubmit" && typeof value.prompt === "string") {
    return { kind: "prompt-context-supported", taskSessionId };
  }
  return { kind: "ignored" };
}

function safeHookOutput(event: HookContractEvent): JsonObject | undefined {
  if (event.kind === "launch-correlated") {
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          "PDF Proofreader correlated this launch with the current Codex task. Live PDF context remains unavailable until the browser activates this exact session.",
      },
    };
  }
  if (event.kind === "prompt-context-supported") {
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          "PDF Proofreader live context is not active for this task. Do not infer a PDF from tabs, recent files, or other sessions.",
      },
    };
  }
  return undefined;
}

/** Read-only installed-boundary probe; it never discovers or mutates a session. */
export function runHookCommand(
  args: readonly string[],
  serializedInput: string,
  write: (text: string) => void = (text) => process.stdout.write(text),
): number {
  if (
    args.length !== 2 || args[0] !== "hook" || args[1] !== "--contract-probe" ||
    Buffer.byteLength(serializedInput) > MAX_HOOK_INPUT_BYTES
  ) return 0;

  let input: unknown;
  try {
    input = JSON.parse(serializedInput) as unknown;
  } catch {
    return 0;
  }
  const output = safeHookOutput(inspectHookEvent(input));
  if (output !== undefined) write(`${JSON.stringify(output)}\n`);
  return 0;
}

export async function readHookStdin(
  input: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  let serialized = "";
  for await (const chunk of input) {
    serialized += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(serialized) > MAX_HOOK_INPUT_BYTES) return "";
  }
  return serialized;
}
