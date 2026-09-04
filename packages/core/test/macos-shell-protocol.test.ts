import { describe, expect, it } from "vitest";

import {
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

  it("accepts atomic revision-fenced drag geometry and rejects stale-shaped input", () => {
    expect(parseMacosPageMessage({
      protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
      type: "drag-regions",
      layoutRevision: 7,
      geometryIdentity: "geometry_12345678",
      regions: [{ x: 12, y: 0, width: 300, height: 52 }],
    })).toMatchObject({ type: "drag-regions", layoutRevision: 7 });
    expect(parseMacosPageMessage({
      protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
      type: "drag-regions",
      layoutRevision: 7,
      geometryIdentity: "geometry_12345678",
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
        trailingInset: 12,
      },
    });
    expect(message).toMatchObject({ type: "bootstrap", document: { displayName: "Paper.pdf" } });
    expect(JSON.stringify(message)).not.toMatch(/path|credential|taskId|token|method/iu);
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
