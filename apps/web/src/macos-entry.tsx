import { useLayoutEffect, useRef, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import {
  MACOS_SHELL_PROTOCOL_VERSION,
  parseMacosNativeMessage,
  type MacosNativeMessage,
  type MacosPageMessage,
  type MacosRect,
} from "../../../packages/core/src/macos-shell-protocol.js";
import { ReviewChrome } from "./review/ReviewChrome.js";
import { unavailableViewerControls } from "./pdf/viewer-controls.js";
import "./app/review-layout.css";

declare global {
  interface Window {
    webkit?: { readonly messageHandlers?: { readonly placekeeperShell?: { postMessage(value: unknown): void } } };
    __PLACEKEEPER_MAC_RECEIVE__?: (value: unknown) => void;
  }
}

export function parseMacosBootstrap(value: unknown): Extract<MacosNativeMessage, { readonly type: "bootstrap" }> | undefined {
  const message = parseMacosNativeMessage(value);
  return message?.type === "bootstrap" ? message : undefined;
}

export function deriveMacosDragRegions(input: {
  readonly layoutRevision: number;
  readonly geometryIdentity: string;
  readonly chromeBounds: MacosRect;
  readonly interactiveBounds: readonly MacosRect[];
}): Extract<MacosPageMessage, { readonly type: "drag-regions" }> {
  const left = input.chromeBounds.x;
  const right = left + input.chromeBounds.width;
  const blocked = input.interactiveBounds
    .map((region) => ({ left: Math.max(left, region.x), right: Math.min(right, region.x + region.width) }))
    .filter((region) => region.right > region.left)
    .sort((a, b) => a.left - b.left);
  const merged: Array<{ left: number; right: number }> = [];
  for (const region of blocked) {
    const previous = merged.at(-1);
    if (previous !== undefined && region.left <= previous.right) previous.right = Math.max(previous.right, region.right);
    else merged.push({ ...region });
  }
  const regions: MacosRect[] = [];
  let cursor = left;
  for (const region of merged) {
    if (region.left > cursor) regions.push({
      x: cursor, y: input.chromeBounds.y, width: region.left - cursor, height: input.chromeBounds.height,
    });
    cursor = Math.max(cursor, region.right);
  }
  if (cursor < right) regions.push({
    x: cursor, y: input.chromeBounds.y, width: right - cursor, height: input.chromeBounds.height,
  });
  return {
    protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
    type: "drag-regions",
    layoutRevision: input.layoutRevision,
    geometryIdentity: input.geometryIdentity,
    regions,
  };
}

function postToNative(value: MacosPageMessage): void {
  window.webkit?.messageHandlers?.placekeeperShell?.postMessage(value);
}

let publishedLayoutRevision = 0;

export function MacosLoadingShell({
  documentTitle,
  geometryIdentity,
}: {
  readonly documentTitle: string;
  readonly geometryIdentity?: string;
}): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const revision = useRef(1);
  useLayoutEffect(() => {
    const shell = root.current;
    if (shell === null || geometryIdentity === undefined) return;
    const publishGeometry = () => {
      const chrome = shell.querySelector<HTMLElement>(".review-chrome");
      if (chrome === null) return;
      const bounds = chrome.getBoundingClientRect();
      const interactive = [...chrome.querySelectorAll<HTMLElement>("button,input,a,[role=button]")]
        .map((element) => element.getBoundingClientRect())
        .map(({ x, y, width, height }) => ({ x, y, width, height }));
      postToNative(deriveMacosDragRegions({
        layoutRevision: revision.current,
        geometryIdentity,
        chromeBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        interactiveBounds: interactive,
      }));
      publishedLayoutRevision = revision.current;
    };
    let cancelled = false;
    void document.fonts.ready.then(() => queueMicrotask(() => {
      if (cancelled) return;
      publishGeometry();
      postToNative({
        protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
        type: "shell-ready",
        layoutRevision: revision.current,
      });
    }));
    const resize = new ResizeObserver(() => {
      revision.current += 1;
      publishGeometry();
    });
    resize.observe(shell);
    return () => {
      cancelled = true;
      resize.disconnect();
    };
  }, [geometryIdentity]);
  return (
    <div ref={root} className="review-shell macos-loading-shell" data-macos-packaged-shell>
      <ReviewChrome
        documentTitle={documentTitle}
        viewerState={unavailableViewerControls()}
        canUndo={false}
        canRedo={false}
        onUndo={() => undefined}
        onRedo={() => undefined}
        saveOptionsAvailable={false}
      />
      <main className="macos-loading-shell__workspace" aria-busy="true">
        <p role="status">Preparing this review…</p>
      </main>
    </div>
  );
}

function start(): void {
  const rootElement = document.querySelector<HTMLElement>("#root");
  if (rootElement === null) throw new Error("Packaged macOS shell root is missing");
  const root = createRoot(rootElement);
  let current: Extract<MacosNativeMessage, { readonly type: "bootstrap" }> | undefined;
  const render = () => root.render(
    <MacosLoadingShell
      documentTitle={current?.document.displayName ?? "Opening PDF"}
      {...(current === undefined ? {} : { geometryIdentity: current.geometry.identity })}
    />,
  );
  window.__PLACEKEEPER_MAC_RECEIVE__ = (value) => {
    const message = parseMacosNativeMessage(value);
    if (message?.type === "bootstrap") {
      current = message;
      render();
    } else if (message?.type === "geometry-changed" && current !== undefined) {
      current = { ...current, geometry: message.geometry };
      render();
    } else if (message?.type === "commit-visible" && current?.geometry.identity === message.geometryIdentity) {
      requestAnimationFrame(() => requestAnimationFrame(() => postToNative({
        protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
        type: "visible-shell-ready",
        layoutRevision: publishedLayoutRevision,
        geometryIdentity: message.geometryIdentity,
        frameSequence: 1,
      })));
    }
  };
  render();
}

if (typeof document !== "undefined") start();
