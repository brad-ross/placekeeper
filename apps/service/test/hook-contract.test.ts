import { describe, expect, it, vi } from "vitest";

import {
  inspectHookEvent,
  runHookCommand,
} from "../src/cli/hook-command.js";

const launchUrl =
  "http://127.0.0.1:43127/s/review-session/bootstrap#cap=browser-capability-secret";

function postToolUse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "thr_codex_task_123",
    turn_id: "turn_123",
    transcript_path: null,
    cwd: "/workspace",
    hook_event_name: "PostToolUse",
    model: "gpt-5",
    permission_mode: "default",
    tool_name: "Bash",
    tool_use_id: "tool_123",
    tool_input: {
      command:
        "pdf-proofreader open --json --surface codex --pdf '/private/tmp/paper with spaces.pdf'",
    },
    tool_response: {
      exit_code: 0,
      output: `${JSON.stringify({
        ok: true,
        kind: "opened",
        url: launchUrl,
        sessionId: "review-session",
      })}\n`,
      wall_time_seconds: 0.2,
    },
    ...overrides,
  };
}

describe("Codex hook contract probe", () => {
  it("correlates one successful Codex-surface launch result with the hosting task", () => {
    expect(inspectHookEvent(postToolUse())).toEqual({
      kind: "launch-correlated",
      taskSessionId: "thr_codex_task_123",
      reviewSessionId: "review-session",
    });
  });

  it.each([
    ["missing task identity", { session_id: undefined }],
    ["failed command", { tool_response: { exit_code: 2, output: "failure" } }],
    [
      "wrong surface",
      {
        tool_input: {
          command:
            "pdf-proofreader open --json --surface finder --pdf '/private/tmp/paper.pdf'",
        },
      },
    ],
    [
      "shell-composed command",
      {
        tool_input: {
          command:
            "pdf-proofreader open --json --surface codex --pdf /private/tmp/paper.pdf && echo captured",
        },
      },
    ],
    [
      "non-loopback result",
      {
        tool_response: {
          exit_code: 0,
          output: `${JSON.stringify({
            ok: true,
            kind: "opened",
            url: "https://example.com/s/review-session/bootstrap#cap=secret",
            sessionId: "review-session",
          })}\n`,
        },
      },
    ],
  ])("rejects %s without attempting ambient discovery", (_label, overrides) => {
    const event = postToolUse(overrides);
    expect(inspectHookEvent(event)).toEqual({ kind: "ignored" });
    const write = vi.fn();
    expect(runHookCommand(
      ["hook", "--contract-probe"],
      JSON.stringify(event),
      write,
    )).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  it("emits bounded developer context without task ids, paths, URLs, or capabilities", () => {
    const write = vi.fn();
    const code = runHookCommand(
      ["hook", "--contract-probe"],
      JSON.stringify(postToolUse()),
      write,
    );

    expect(code).toBe(0);
    expect(write).toHaveBeenCalledOnce();
    const serialized = write.mock.calls[0]![0] as string;
    expect(JSON.parse(serialized)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          "PDF Proofreader correlated this launch with the current Codex task. Live PDF context remains unavailable until the browser activates this exact session.",
      },
    });
    expect(serialized).not.toMatch(/thr_codex|review-session|paper with spaces|cap=|127\.0\.0\.1/u);
  });

  it("uses the documented UserPromptSubmit additionalContext shape without inspecting the transcript", () => {
    const event = {
      session_id: "thr_codex_task_123",
      turn_id: "turn_456",
      transcript_path: "/private/tmp/unstable-transcript.jsonl",
      cwd: "/workspace",
      hook_event_name: "UserPromptSubmit",
      model: "gpt-5",
      permission_mode: "default",
      prompt: "What did I annotate?",
    };
    expect(inspectHookEvent(event)).toEqual({
      kind: "prompt-context-supported",
      taskSessionId: "thr_codex_task_123",
    });

    const write = vi.fn();
    expect(runHookCommand(
      ["hook", "--contract-probe"],
      JSON.stringify(event),
      write,
    )).toBe(0);
    const serialized = write.mock.calls[0]![0] as string;
    expect(JSON.parse(serialized)).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          "PDF Proofreader live context is not active for this task. Do not infer a PDF from tabs, recent files, or other sessions.",
      },
    });
    expect(serialized).not.toContain("unstable-transcript");
    expect(serialized).not.toContain("What did I annotate?");
  });

  it("fails closed with content-free output for malformed input", () => {
    const write = vi.fn();
    expect(runHookCommand(
      ["hook", "--contract-probe"],
      "{not-json /private/tmp/private.pdf #cap=secret",
      write,
    )).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });
});
