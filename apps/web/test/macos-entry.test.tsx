import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MacosLoadingShell,
  deriveMacosDragRegions,
  macosCommandInvocationForSnapshot,
  measureMacosInteractiveBounds,
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

  it("keeps native traffic lights and web controls outside drag overlays", () => {
    expect(deriveMacosDragRegions({
      layoutRevision: 8,
      geometryIdentity: "geometry_12345678",
      chromeBounds: { x: 0, y: 0, width: 1200, height: 58 },
      leadingInset: 92,
      interactiveBounds: [{ x: 160, y: 14, width: 820, height: 30 }],
    })).toEqual({
      protocolVersion: 1,
      type: "drag-regions",
      layoutRevision: 8,
      geometryIdentity: "geometry_12345678",
      transitioning: false,
      regions: [
        { x: 92, y: 0, width: 1108, height: 14 },
        { x: 92, y: 14, width: 68, height: 30 },
        { x: 980, y: 14, width: 220, height: 30 },
        { x: 92, y: 44, width: 1108, height: 14 },
      ],
    });
  });

  it("ignores inert sizing controls when measuring native drag blockers", () => {
    const element = (bounds: { x: number; y: number; width: number; height: number }, inert: boolean) => ({
      closest: () => inert ? {} : null,
      getBoundingClientRect: () => bounds,
    }) as unknown as HTMLElement;

    expect(measureMacosInteractiveBounds([
      element({ x: 80, y: 14, width: 140, height: 30 }, false),
      element({ x: 220, y: 14, width: 500, height: 30 }, true),
    ])).toEqual([{ x: 80, y: 14, width: 140, height: 30 }]);
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
