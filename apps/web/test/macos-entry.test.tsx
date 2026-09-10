import { readCssSource } from '../../../test/support/read-css-source.js';

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MacosLoadingShell,
  MACOS_TITLEBAR_INTERACTIVE_SELECTOR,
  MACOS_TITLEBAR_POPUP_SELECTOR,
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
    };
    expect(parseMacosBootstrap(safe)).toMatchObject({ document: { displayName: "Paper.pdf" } });
    expect(parseMacosBootstrap({ ...safe, path: "/tmp/Paper.pdf" })).toBeUndefined();
  });

  it("makes every noninteractive titlebar pixel around native and web controls draggable", () => {
    expect(deriveMacosDragRegions({
      layoutRevision: 8,
      geometryIdentity: "geometry_12345678",
      chromeBounds: { x: 0, y: 0, width: 1200, height: 58 },
      trafficLightBounds: [
        { x: 16, y: 20, width: 14, height: 14 },
        { x: 36, y: 20, width: 14, height: 14 },
        { x: 56, y: 20, width: 14, height: 14 },
      ],
      interactiveBounds: [{ x: 160, y: 14, width: 820, height: 30 }],
    })).toEqual({
      protocolVersion: 1,
      type: "drag-regions",
      layoutRevision: 8,
      geometryIdentity: "geometry_12345678",
      transitioning: false,
      regions: [
        { x: 0, y: 0, width: 1200, height: 14 },
        { x: 0, y: 14, width: 160, height: 6 },
        { x: 980, y: 14, width: 220, height: 30 },
        { x: 0, y: 20, width: 16, height: 14 },
        { x: 30, y: 20, width: 6, height: 14 },
        { x: 50, y: 20, width: 6, height: 14 },
        { x: 70, y: 20, width: 90, height: 14 },
        { x: 0, y: 34, width: 160, height: 10 },
        { x: 0, y: 44, width: 1200, height: 14 },
      ],
    });
  });

  it("centers the shared titlebar in a row balanced around the native traffic lights", () => {
    const html = renderToStaticMarkup(<MacosLoadingShell
      documentTitle="Paper.pdf"
      trafficLightBounds={[
        { x: 16, y: 20, width: 14, height: 14 },
        { x: 36, y: 20, width: 14, height: 14 },
        { x: 56, y: 20, width: 14, height: 14 },
      ]}
    />);
    expect(html).toContain("--macos-traffic-light-center-y:27px");
    const layoutCss = readCssSource(new URL("../src/app/review-layout-foundation.css", import.meta.url));
    expect(layoutCss).toMatch(/\[data-launch-surface="macos"\] \.review-chrome\s*\{[^}]*--review-chrome-height:\s*calc\(var\(--macos-traffic-light-center-y, 25px\) \* 2\)/u);
  });

  it("keeps every focusable titlebar control out of native drag overlays", () => {
    for (const selector of [
      "button",
      "input",
      "select",
      "textarea",
      "a[href]",
      "summary",
      "[contenteditable]:not([contenteditable='false'])",
      "[role='button']",
      "[role='link']",
      "[tabindex]:not([tabindex='-1'])",
    ]) expect(MACOS_TITLEBAR_INTERACTIVE_SELECTOR.split(",")).toContain(selector);
    expect(MACOS_TITLEBAR_POPUP_SELECTOR).toBe(".document-actions__menu");
  });

  it("never overlaps controls or the portion of an open menu inside the draggable band", () => {
    const blocked = [
      { x: 86, y: 11, width: 220, height: 32 },
      { x: 900, y: 11, width: 260, height: 32 },
      { x: 850, y: 48, width: 180, height: 120 },
    ];
    const { regions } = deriveMacosDragRegions({
      layoutRevision: 9,
      geometryIdentity: "geometry_12345678",
      chromeBounds: { x: 0, y: 0, width: 1200, height: 54 },
      trafficLightBounds: [
        { x: 16, y: 20, width: 14, height: 14 },
        { x: 36, y: 20, width: 14, height: 14 },
        { x: 56, y: 20, width: 14, height: 14 },
      ],
      interactiveBounds: blocked,
    });
    const overlaps = (first: typeof blocked[number], second: typeof blocked[number]) => (
      first.x < second.x + second.width && first.x + first.width > second.x
      && first.y < second.y + second.height && first.y + first.height > second.y
    );
    expect(regions.some((region) => (
      region.x <= 500 && region.x + region.width > 500
      && region.y <= 27 && region.y + region.height > 27
    ))).toBe(true);
    for (const region of regions) {
      for (const blocker of blocked) expect(overlaps(region, blocker)).toBe(false);
    }
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
