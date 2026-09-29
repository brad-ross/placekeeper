import { finishZoomForPresentation, resumeZoomAfterPresentation } from "./pdf/anchored-zoom.js";
import { useCallback, useLayoutEffect, useRef, type CSSProperties, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import {
  MACOS_SHELL_PROTOCOL_VERSION,
  parseMacosNativeMessage,
  type MacosNativeMessage,
  type MacosPageMessage,
  type MacosRect,
} from "../../../packages/core/src/macos-shell-protocol.js";
import type { HostRuntime } from "./host/runtime.js";
import { createMacosHostRuntime } from "./host/macos-runtime.js";
import { RuntimeProductionReviewApp } from "./production-entry.js";
import type {
  ReviewCommandInvocation,
  ReviewCommandSurfaceSnapshot,
} from "./review/review-command-surface.js";
import "./app/review-layout.css";

declare global {
  interface Window {
    webkit?: { readonly messageHandlers?: { readonly placekeeperShell?: { postMessage(value: unknown): void } } };
    __PLACEKEEPER_MAC_RECEIVE__?: (value: unknown) => boolean | void;
    __PLACEKEEPER_MAC_DISMISS_TOP_BAR_MENUS__?: () => void;
  }
}

export function dismissMacosTopBarMenus(documentRef: Document = document): void {
  const PointerEventType = documentRef.defaultView?.PointerEvent;
  if (PointerEventType === undefined) return;
  documentRef.dispatchEvent(new PointerEventType("pointerdown", {
    bubbles: true,
    cancelable: true,
    pointerType: "mouse",
  }));
}

export function parseMacosBootstrap(value: unknown): Extract<MacosNativeMessage, { readonly type: "bootstrap" }> | undefined {
  const message = parseMacosNativeMessage(value);
  return message?.type === "bootstrap" ? message : undefined;
}

export function deriveMacosDragRegions(input: {
  readonly layoutRevision: number;
  readonly geometryIdentity: string;
  readonly chromeBounds: MacosRect;
  readonly trafficLightBounds: readonly MacosRect[];
  readonly interactiveBounds: readonly MacosRect[];
  readonly transitioning?: boolean;
}): Extract<MacosPageMessage, { readonly type: "drag-regions" }> {
  if (input.transitioning === true) return {
    protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
    type: "drag-regions",
    layoutRevision: input.layoutRevision,
    geometryIdentity: input.geometryIdentity,
    transitioning: true,
    regions: [],
  };
  const left = input.chromeBounds.x;
  const top = input.chromeBounds.y;
  const right = left + input.chromeBounds.width;
  const bottom = top + input.chromeBounds.height;
  const blocked = [...input.trafficLightBounds, ...input.interactiveBounds].map((region) => ({
    left: Math.max(left, region.x),
    top: Math.max(top, region.y),
    right: Math.min(right, region.x + region.width),
    bottom: Math.min(bottom, region.y + region.height),
  })).filter((region) => region.right > region.left && region.bottom > region.top);
  const yBoundaries = [...new Set([
    top,
    bottom,
    ...blocked.flatMap((region) => [region.top, region.bottom]),
  ])].sort((a, b) => a - b);
  const regions: MacosRect[] = [];
  let activeRegions = new Map<string, number>();
  for (let index = 0; index < yBoundaries.length - 1; index += 1) {
    const bandTop = yBoundaries[index]!;
    const bandBottom = yBoundaries[index + 1]!;
    const blockedInBand = blocked
      .filter((region) => region.top < bandBottom && region.bottom > bandTop)
      .map(({ left: regionLeft, right: regionRight }) => ({ left: regionLeft, right: regionRight }))
      .sort((a, b) => a.left - b.left);
    const merged: Array<{ left: number; right: number }> = [];
    for (const region of blockedInBand) {
      const previous = merged.at(-1);
      if (previous !== undefined && region.left <= previous.right) previous.right = Math.max(previous.right, region.right);
      else merged.push({ ...region });
    }
    const open: Array<{ left: number; right: number }> = [];
    let cursor = left;
    for (const region of merged) {
      if (region.left > cursor) open.push({ left: cursor, right: region.left });
      cursor = Math.max(cursor, region.right);
    }
    if (cursor < right) open.push({ left: cursor, right });

    const nextActiveRegions = new Map<string, number>();
    for (const region of open) {
      const key = `${region.left}:${region.right}`;
      const activeIndex = activeRegions.get(key);
      if (activeIndex !== undefined) {
        const active = regions[activeIndex]!;
        regions[activeIndex] = { ...active, height: bandBottom - active.y };
        nextActiveRegions.set(key, activeIndex);
      } else {
        regions.push({
          x: region.left,
          y: bandTop,
          width: region.right - region.left,
          height: bandBottom - bandTop,
        });
        nextActiveRegions.set(key, regions.length - 1);
      }
    }
    activeRegions = nextActiveRegions;
  }
  return {
    protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
    type: "drag-regions",
    layoutRevision: input.layoutRevision,
    geometryIdentity: input.geometryIdentity,
    transitioning: false,
    regions,
  };
}

export function measureMacosInteractiveBounds(elements: readonly HTMLElement[]): MacosRect[] {
  return elements
    .filter((element) => element.closest("[inert],[hidden],[aria-hidden='true']") === null)
    .map((element) => element.getBoundingClientRect())
    .map(({ x, y, width, height }) => ({ x, y, width, height }))
    .filter(({ width, height }) => width > 0 && height > 0);
}

export const MACOS_TITLEBAR_INTERACTIVE_SELECTOR = [
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
  // The gaps inside a control group (between Undo and Redo, say) are part of
  // the group, not window background, so they must not drag the window.
  "[data-review-chrome-group]",
].join(",");

export const MACOS_TITLEBAR_POPUP_SELECTOR = ".document-actions__menu";

function postToNative(value: MacosPageMessage): void {
  window.webkit?.messageHandlers?.placekeeperShell?.postMessage(value);
}

let publishedLayoutRevision = 0;

export function macosCommandInvocationForSnapshot(
  invocation: Extract<MacosNativeMessage, { readonly type: "invoke-command" }> | undefined,
  currentSnapshotRevision: number,
): ReviewCommandInvocation | undefined {
  return invocation === undefined || invocation.snapshotRevision !== currentSnapshotRevision
    ? undefined
    : { id: invocation.command, token: invocation.token };
}

export function MacosLoadingShell({
  documentTitle,
  geometryIdentity,
  trafficLightInset = 0,
  trafficLightBounds = [],
  trailingInset = 0,
  runtime,
  runtimeId,
  attemptId,
  nativeCommandInvocation,
  transitionVisible = false,
}: {
  readonly documentTitle: string;
  readonly geometryIdentity?: string;
  readonly trafficLightInset?: number;
  readonly trafficLightBounds?: readonly MacosRect[];
  readonly trailingInset?: number;
  readonly runtime?: HostRuntime;
  readonly runtimeId?: string;
  readonly attemptId?: string;
  readonly nativeCommandInvocation?: Extract<MacosNativeMessage, { readonly type: "invoke-command" }>;
  readonly transitionVisible?: boolean;
}): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const revision = useRef(1);
  const commandRevision = useRef(0);
  const commandInvocation = macosCommandInvocationForSnapshot(
    nativeCommandInvocation,
    commandRevision.current,
  );
  const publishCommandSurface = useCallback((snapshot: ReviewCommandSurfaceSnapshot) => {
    if (runtimeId === undefined || attemptId === undefined) return;
    commandRevision.current += 1;
    postToNative({
      protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
      type: "command-snapshot",
      runtimeId,
      attemptId,
      revision: commandRevision.current,
      focusContext: snapshot.focusContext,
      commands: snapshot.commands,
    });
  }, [attemptId, runtimeId]);
  const publishDocumentReady = useCallback((generation: number) => {
    if (runtimeId === undefined || attemptId === undefined) return;
    postToNative({
      protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
      type: "document-ready",
      runtimeId,
      attemptId,
      generation,
    });
  }, [attemptId, runtimeId]);
  const publishRuntimeError = useCallback(() => {
    if (runtimeId === undefined || attemptId === undefined) return;
    postToNative({
      protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
      type: "runtime-error",
      runtimeId,
      attemptId,
      stage: "runtime",
    });
  }, [attemptId, runtimeId]);
  useLayoutEffect(() => {
    const shell = root.current;
    if (shell === null || geometryIdentity === undefined) return;
    let frame = 0;
    const chrome = shell.querySelector<HTMLElement>(".review-chrome");
    if (chrome === null) return;
    let observedPopups = new Set<HTMLElement>();
    const resize = new ResizeObserver(scheduleGeometry);
    const popupMutations = new MutationObserver(scheduleGeometry);
    const syncPopupObservers = (popups: readonly HTMLElement[]) => {
      const nextPopups = new Set(popups);
      for (const popup of observedPopups) {
        if (!nextPopups.has(popup)) resize.unobserve(popup);
      }
      popupMutations.disconnect();
      for (const popup of nextPopups) {
        resize.observe(popup);
        popupMutations.observe(popup, {
          attributes: true,
          attributeFilter: ["style", "data-placement"],
        });
      }
      observedPopups = nextPopups;
    };
    const measureGeometry = () => {
      const bounds = chrome.getBoundingClientRect();
      const popups = [
        ...shell.ownerDocument.querySelectorAll<HTMLElement>(MACOS_TITLEBAR_POPUP_SELECTOR),
      ];
      syncPopupObservers(popups);
      const interactive = measureMacosInteractiveBounds([
        ...chrome.querySelectorAll<HTMLElement>(MACOS_TITLEBAR_INTERACTIVE_SELECTOR),
        ...popups,
      ]);
      const chromeBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      return { chromeBounds, interactive, signature: JSON.stringify([chromeBounds, interactive]) };
    };
    const publishGeometry = (measurement: ReturnType<typeof measureGeometry>, transitioning = false) => {
      postToNative(deriveMacosDragRegions({
        layoutRevision: revision.current,
        geometryIdentity,
        chromeBounds: measurement.chromeBounds,
        trafficLightBounds,
        interactiveBounds: measurement.interactive,
        transitioning,
      }));
      publishedLayoutRevision = revision.current;
      if (!transitioning) resumeZoomAfterPresentation(document, geometryIdentity);
    };
    let signature = "";
    let cancelled = false;
    void document.fonts.ready.then(() => queueMicrotask(() => {
      if (cancelled) return;
      const measurement = measureGeometry();
      signature = measurement.signature;
      publishGeometry(measurement);
      postToNative({
        protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
        type: "shell-ready",
        layoutRevision: revision.current,
      });
    }));
    function scheduleGeometry() {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const measurement = measureGeometry();
        if (measurement.signature === signature) return;
        signature = measurement.signature;
        revision.current += 1;
        publishGeometry(measurement, true);
        frame = requestAnimationFrame(() => {
          frame = 0;
          const settled = measureGeometry();
          signature = settled.signature;
          publishGeometry(settled);
        });
      });
    }
    resize.observe(shell);
    resize.observe(chrome);
    const mutations = new MutationObserver(scheduleGeometry);
    mutations.observe(chrome, { subtree: true, childList: true, attributes: true });
    return () => {
      cancelled = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      popupMutations.disconnect();
      observedPopups.clear();
    };
  }, [geometryIdentity, trafficLightBounds]);
  const trafficLightTop = Math.min(...trafficLightBounds.map(({ y }) => y));
  const trafficLightBottom = Math.max(...trafficLightBounds.map(({ y, height }) => y + height));
  const trafficLightCenterY = Number.isFinite(trafficLightTop) && Number.isFinite(trafficLightBottom)
    ? (trafficLightTop + trafficLightBottom) / 2
    : undefined;
  return (
    <div
      ref={root}
      className="macos-loading-shell"
      data-macos-packaged-shell
      style={{
        "--macos-titlebar-leading-inset": `${trafficLightInset}px`,
        ...(trafficLightCenterY === undefined ? {} : {
          "--macos-traffic-light-center-y": `${trafficLightCenterY}px`,
        }),
        "--macos-titlebar-trailing-inset": `${trailingInset}px`,
      } as CSSProperties}
    >
      <RuntimeProductionReviewApp
        {...(runtime === undefined ? {} : { runtime })}
        loadingDocumentTitle={documentTitle}
        onDocumentReady={publishDocumentReady}
        onRuntimeError={publishRuntimeError}
        onCommandSurfaceChange={publishCommandSurface}
        {...(commandInvocation === undefined ? {} : { commandInvocation })}
        {...(attemptId === undefined ? {} : {
          transitionAttemptId: attemptId,
          transitionVisible,
        })}
      />
    </div>
  );
}

export function prepareMacosPresentationTransition(
  message: Extract<MacosNativeMessage, { readonly type: "presentation-transition" }>,
  current: Extract<MacosNativeMessage, { readonly type: "bootstrap" }> | undefined,
  root: Document,
): boolean {
  if (message.runtimeId !== current?.runtimeId || message.attemptId !== current.attemptId
    || message.geometryIdentity !== current.geometry.identity) return false;
  finishZoomForPresentation(root, message.geometryIdentity);
  return true;
}

function start(): void {
  const rootElement = document.querySelector<HTMLElement>("#root");
  if (rootElement === null) throw new Error("Packaged macOS shell root is missing");
  rootElement.dataset.productionRoot = "true";
  const root = createRoot(rootElement);
  window.__PLACEKEEPER_MAC_DISMISS_TOP_BAR_MENUS__ = () => dismissMacosTopBarMenus();
  let current: Extract<MacosNativeMessage, { readonly type: "bootstrap" }> | undefined;
  let runtime: HostRuntime | undefined;
  let nativeCommandInvocation: Extract<MacosNativeMessage, { readonly type: "invoke-command" }> | undefined;
  let visibleAttempt = false;
  const runtimeListeners = new Set<(message: MacosNativeMessage) => void>();
  const installRuntime = () => {
    if (runtime !== undefined || current?.runtimeId === undefined || current.attemptId === undefined) return;
    runtime = createMacosHostRuntime({
      runtimeId: current.runtimeId,
      attemptId: current.attemptId,
      postToNative,
      subscribeNative(listener) {
        runtimeListeners.add(listener);
        return () => runtimeListeners.delete(listener);
      },
    });
  };
  const render = () => root.render(
    <MacosLoadingShell
      documentTitle={current?.document.displayName ?? "Opening PDF"}
      {...(current === undefined ? {} : { geometryIdentity: current.geometry.identity })}
      {...(current === undefined ? {} : {
        trafficLightInset: current.geometry.trafficLightInset,
        trafficLightBounds: current.geometry.trafficLightBounds,
        trailingInset: current.geometry.trailingInset,
      })}
      {...(runtime === undefined ? {} : { runtime })}
      {...(current?.runtimeId === undefined ? {} : { runtimeId: current.runtimeId })}
      {...(current?.attemptId === undefined ? {} : { attemptId: current.attemptId })}
      {...(nativeCommandInvocation === undefined ? {} : { nativeCommandInvocation })}
      transitionVisible={visibleAttempt}
    />,
  );
  window.__PLACEKEEPER_MAC_RECEIVE__ = (value) => {
    const message = parseMacosNativeMessage(value);
    if (message?.type === "presentation-transition") {
      return prepareMacosPresentationTransition(message, current, document);
    } else if (message?.type === "bootstrap") {
      current = message;
      visibleAttempt = false;
      nativeCommandInvocation = undefined;
      installRuntime();
      render();
    } else if (message?.type === "geometry-changed" && current !== undefined) {
      current = { ...current, geometry: message.geometry };
      render();
    } else if (message?.type === "commit-visible" && current?.geometry.identity === message.geometryIdentity) {
      if (!visibleAttempt) {
        visibleAttempt = true;
        render();
      }
      requestAnimationFrame(() => requestAnimationFrame(() => postToNative({
        protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
        type: "visible-shell-ready",
        layoutRevision: publishedLayoutRevision,
        geometryIdentity: message.geometryIdentity,
        frameSequence: 1,
      })));
    } else if (message?.type === "runtime-message") {
      for (const listener of runtimeListeners) listener(message);
    } else if (
      message?.type === "invoke-command"
      && message.runtimeId === current?.runtimeId
      && message.attemptId === current.attemptId
    ) {
      nativeCommandInvocation = message;
      render();
    }
  };
  globalThis.addEventListener("pagehide", () => {
    delete window.__PLACEKEEPER_MAC_DISMISS_TOP_BAR_MENUS__;
    runtime?.dispose();
  }, { once: true });
  render();
}

if (typeof document !== "undefined") start();
