import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MacosLoadingShell,
  deriveMacosDragRegions,
  macosCommandInvocationForSnapshot,
  parseMacosBootstrap,
} from "../src/macos-entry.js";

describe("packaged macOS shell entry", () => {
  it("renders the real shared toolbar once with final disabled control positions", () => {
    const html = renderToStaticMarkup(<MacosLoadingShell documentTitle="Paper.pdf" />);
    expect(html.match(/<header[^>]*data-review-chrome/g)).toHaveLength(1);
    expect(html).toContain("Paper.pdf");
    expect(html).toContain("Page controls become available when PDF navigation is ready.");
    expect(html).toContain("Preparing this review");
  });

  it("accepts only sanitized native bootstrap data", () => {
    const safe = {
      protocolVersion: 1,
      type: "bootstrap",
      document: {
        displayName: "Paper.pdf",
        resource: {
          url: "placekeeper-resource://document/resource_12345678?generation=1&role=document",
          generation: 1,
          mime: "application/pdf",
          byteLength: 995,
          digest: "a".repeat(64),
        },
      },
      geometry: { identity: "geometry_12345678", trafficLightInset: 76, trailingInset: 12 },
    };
    expect(parseMacosBootstrap(safe)).toMatchObject({ document: { displayName: "Paper.pdf" } });
    expect(parseMacosBootstrap({ ...safe, path: "/tmp/Paper.pdf" })).toBeUndefined();
  });

  it("publishes only noninteractive titlebar regions with a revision fence", () => {
    expect(deriveMacosDragRegions({
      layoutRevision: 8,
      geometryIdentity: "geometry_12345678",
      chromeBounds: { x: 0, y: 0, width: 1200, height: 58 },
      interactiveBounds: [{ x: 80, y: 0, width: 900, height: 58 }],
    })).toEqual({
      protocolVersion: 1,
      type: "drag-regions",
      layoutRevision: 8,
      geometryIdentity: "geometry_12345678",
      transitioning: false,
      regions: [
        { x: 0, y: 0, width: 80, height: 58 },
        { x: 980, y: 0, width: 220, height: 58 },
      ],
    });
  });

  it("drops native invocations captured from a stale command snapshot", () => {
    const invocation = {
      protocolVersion: 1 as const,
      type: "invoke-command" as const,
      runtimeId: "runtime_identifier_1234",
      attemptId: "attempt_identifier_1234",
      command: "undo" as const,
      snapshotRevision: 4,
      token: 9,
    };
    expect(macosCommandInvocationForSnapshot(invocation, 4)).toEqual({ id: "undo", token: 9 });
    expect(macosCommandInvocationForSnapshot(invocation, 5)).toBeUndefined();
  });
});
