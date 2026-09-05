import { describe, expect, it } from "vitest";

import {
  MACOS_REVIEW_COMMAND_IDS,
  MACOS_SHELL_PROTOCOL_VERSION,
  parseMacosBundleURL,
  parseMacosNativeMessage,
  parseMacosPageMessage,
  parseMacosResourceURL,
} from "../src/macos-shell-protocol.js";

describe("macOS packaged-shell protocol", () => {
  it("keeps shell readiness and confirmed visible paint distinct", () => {
    expect(parseMacosPageMessage({
      protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
      type: "shell-ready",
      layoutRevision: 4,
    })).toMatchObject({ type: "shell-ready", layoutRevision: 4 });
    expect(parseMacosPageMessage({
      protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
      type: "visible-shell-ready",
      layoutRevision: 4,
      geometryIdentity: "geometry_12345678",
      frameSequence: 1,
    })).toMatchObject({ type: "visible-shell-ready", frameSequence: 1 });
  });

  it("accepts document readiness only for a current-shaped runtime attempt", () => {
    expect(parseMacosPageMessage({
      protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
      type: "document-ready",
      runtimeId: "runtime_identifier_1234",
      attemptId: "attempt_identifier_1234",
      generation: 2,
    })).toMatchObject({ type: "document-ready", generation: 2 });
    expect(parseMacosPageMessage({
      protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
      type: "document-ready",
      runtimeId: "runtime_identifier_1234",
      attemptId: "attempt_identifier_1234",
      generation: 0,
    })).toBeUndefined();
    expect(parseMacosPageMessage({
      protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
      type: "runtime-error",
      runtimeId: "runtime_identifier_1234",
      attemptId: "attempt_identifier_1234",
      stage: "runtime",
    })).toMatchObject({ type: "runtime-error", stage: "runtime" });
  });

  it("accepts atomic revision-fenced drag geometry and rejects stale-shaped input", () => {
    expect(parseMacosPageMessage({
      protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
      type: "drag-regions",
      layoutRevision: 7,
      geometryIdentity: "geometry_12345678",
      transitioning: false,
      regions: [{ x: 12, y: 0, width: 300, height: 52 }],
    })).toMatchObject({ type: "drag-regions", layoutRevision: 7 });
    expect(parseMacosPageMessage({
      protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
      type: "drag-regions",
      layoutRevision: 7,
      geometryIdentity: "geometry_12345678",
      transitioning: false,
      regions: [],
      path: "/tmp/paper.pdf",
    })).toBeUndefined();
  });

  it("projects only display identity and one opaque generation-bound resource", () => {
    const message = parseMacosNativeMessage({
      protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
      type: "bootstrap",
      document: {
        displayName: "Paper.pdf",
        resource: {
          url: "placekeeper-resource://document/resource_12345678?generation=2&role=document",
          generation: 2,
          mime: "application/pdf",
          byteLength: 995,
          digest: "a".repeat(64),
        },
      },
      geometry: {
        identity: "geometry_12345678",
        trafficLightInset: 76,
        trafficLightBounds: [
          { x: 16, y: 20, width: 14, height: 14 },
          { x: 36, y: 20, width: 14, height: 14 },
          { x: 56, y: 20, width: 14, height: 14 },
        ],
        trailingInset: 12,
      },
    });
    expect(message).toMatchObject({ type: "bootstrap", document: { displayName: "Paper.pdf" } });
    expect(JSON.stringify(message)).not.toMatch(/path|credential|taskId|token|method/iu);
    expect(parseMacosNativeMessage({ ...message, attemptId: "attempt_identifier_1234" }))
      .toBeUndefined();
  });

  it("fails closed on sensitive, generic, oversized, or malformed page messages", () => {
    for (const value of [
      { protocolVersion: 1, type: "invoke", method: "anything" },
      { protocolVersion: 1, type: "shell-ready", layoutRevision: 1, credential: "secret" },
      { protocolVersion: 1, type: "shell-ready", layoutRevision: -1 },
      { protocolVersion: 2, type: "shell-ready", layoutRevision: 1 },
      "not-an-object",
    ]) expect(parseMacosPageMessage(value)).toBeUndefined();
  });

  it("carries only closed Mac runtime requests on the attempt-fenced bridge", () => {
    const message = parseMacosPageMessage({
      protocolVersion: 1,
      type: "runtime-message",
      runtimeId: "runtime_identifier_1234",
      attemptId: "attempt_identifier_1234",
      message: {
        protocol: "placekeeper.review-runtime",
        version: 1,
        kind: "request",
        runtimeId: "runtime_identifier_1234",
        requestId: "request_identifier_1234",
        method: "bootstrap",
        payload: {},
      },
    });
    expect(message).toMatchObject({ type: "runtime-message", message: { method: "bootstrap" } });
    expect(parseMacosPageMessage({
      ...(message as object),
      message: {
        protocol: "placekeeper.review-runtime",
        version: 1,
        kind: "request",
        runtimeId: "runtime_identifier_1234",
        requestId: "request_identifier_1234",
        method: "scope",
        payload: { sourcePath: "/private/forbidden.pdf" },
      },
    })).toBeUndefined();
  });

  it("carries a complete primitive command projection and closed invocation", () => {
    const commands = MACOS_REVIEW_COMMAND_IDS.map((id) => ({
      id,
      label: id === "undo" ? "Undo Review Change" : id,
      enabled: id === "undo",
      ...(id === "undo" ? { shortcut: "Meta+Z" } : {}),
    }));
    expect(parseMacosPageMessage({
      protocolVersion: 1,
      type: "command-snapshot",
      runtimeId: "runtime_identifier_1234",
      attemptId: "attempt_identifier_1234",
      revision: 3,
      focusContext: "review",
      commands,
    })).toMatchObject({ type: "command-snapshot", revision: 3, commands });
    expect(parseMacosNativeMessage({
      protocolVersion: 1,
      type: "invoke-command",
      runtimeId: "runtime_identifier_1234",
      attemptId: "attempt_identifier_1234",
      command: "undo",
      snapshotRevision: 3,
      token: 4,
    })).toMatchObject({ type: "invoke-command", command: "undo", token: 4 });
    expect(parseMacosPageMessage({
      protocolVersion: 1,
      type: "command-snapshot",
      runtimeId: "runtime_identifier_1234",
      attemptId: "attempt_identifier_1234",
      revision: 3,
      focusContext: "review",
      commands: commands.map((command) => ({ ...command, sourcePath: "/private/paper.pdf" })),
    })).toBeUndefined();
  });

  it("uses closed canonical bundle and resource URL grammars", () => {
    expect(parseMacosBundleURL("placekeeper-app://bundle/macos.html"))
      .toEqual({ manifestKey: "macos.html" });
    expect(parseMacosResourceURL(
      "placekeeper-resource://document/resource_12345678?generation=2&role=document",
    )).toEqual({ resourceId: "resource_12345678", generation: 2, role: "document" });
    for (const url of [
      "https://127.0.0.1:43127/review",
      "placekeeper-app://user:pass@bundle/macos.html",
      "placekeeper-app://bundle/../secret",
      "placekeeper-app://bundle/macos.html?free=form",
      "placekeeper-resource://document/resource_12345678?generation=2&role=thumbnail",
      "placekeeper-resource://document/resource_12345678?role=document&generation=2&extra=1",
    ]) {
      expect(parseMacosBundleURL(url)).toBeUndefined();
      expect(parseMacosResourceURL(url)).toBeUndefined();
    }
  });
});
