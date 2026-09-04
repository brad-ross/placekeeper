import { useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { createRoot } from "react-dom/client";

import {
  createStaticHostRuntime,
  isStaticOperationCancelled,
  readStaticPdfFile,
  readStaticPdfUrl,
} from "./host/static-runtime.js";
import { startRuntime } from "./production-entry.js";
import { ReviewIcon } from "./review/ReviewIcon.js";
import "./static-entry.css";

// The static Vite plugin replaces these with content-addressed Rollup asset URLs.
const PDFIUM_WASM_ASSET = "__PLACEKEEPER_STATIC_PDFIUM_WASM__";
const PDFIUM_WORKER_ASSET = "__PLACEKEEPER_STATIC_PDFIUM_WORKER__";
const PLACEKEEPER_ICON_URL = new URL("../../../packaging/macos/icon/Placekeeper.svg", import.meta.url).href;

const ACTIVATION_TIMEOUT_MS = 30_000;

type OpeningPhase = "idle" | "acquiring" | "assessing" | "activating";
type SourceControl = "file" | "url";

const OPENING_STATUS: Readonly<Record<Exclude<OpeningPhase, "idle">, string>> = {
  acquiring: "Reading the PDF…",
  assessing: "Checking whether this PDF can be safely annotated…",
  activating: "Preparing the PDF viewer…",
};

function cancelledOpening(): DOMException {
  return new DOMException("Opening was cancelled.", "AbortError");
}

function waitForActivation(
  ready: Promise<void>,
  signal: AbortSignal,
  timeoutMs = ACTIVATION_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => finish(() => reject(cancelledOpening()));
    timer = globalThis.setTimeout(() => finish(() => reject(new Error(
      "The PDF viewer took too long to become ready. Try opening the PDF again.",
    ))), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    ready.then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function droppedPdf(dataTransfer: DataTransfer): File {
  const files = [...dataTransfer.files];
  const containsDirectory = [...dataTransfer.items].some((item) => (
    item.kind === "file" && item.webkitGetAsEntry?.()?.isDirectory === true
  ));
  if (containsDirectory || files.length !== 1) {
    throw new Error("Drop exactly one PDF file, not a folder or multiple files.");
  }
  return files[0]!;
}

export function StaticLauncher(props: {
  readonly onOpen: (
    source: File | string,
    options: {
      readonly signal: AbortSignal;
      readonly onPhase: (phase: Exclude<OpeningPhase, "idle">) => void;
    },
  ) => Promise<void>;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseButtonRef = useRef<HTMLButtonElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const operationRef = useRef<AbortController | undefined>(undefined);
  const [phase, setPhase] = useState<OpeningPhase>("idle");
  const [error, setError] = useState<string>();
  const [remoteUrl, setRemoteUrl] = useState("");
  const [focusTarget, setFocusTarget] = useState<SourceControl>();
  const pending = phase !== "idle";

  useEffect(() => {
    if (phase !== "idle" || focusTarget === undefined) return;
    (focusTarget === "url" ? urlInputRef.current : chooseButtonRef.current)
      ?.focus({ preventScroll: true });
    setFocusTarget(undefined);
  }, [focusTarget, phase]);

  const restoreFocus = (control: SourceControl) => setFocusTarget(control);
  const open = async (source: File | string | undefined, control: SourceControl) => {
    if (source === undefined || (typeof source === "string" && source.trim() === "") || pending) return;
    const controller = new AbortController();
    operationRef.current = controller;
    if (typeof source === "string") setRemoteUrl("");
    setPhase("acquiring");
    setError(undefined);
    try {
      await props.onOpen(source, {
        signal: controller.signal,
        onPhase: setPhase,
      });
    } catch (cause) {
      if (!isStaticOperationCancelled(cause) && !(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "This PDF could not be opened.");
      }
      setPhase("idle");
      restoreFocus(control);
    } finally {
      if (operationRef.current === controller) operationRef.current = undefined;
    }
  };
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    void open(file, "file");
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (pending) return;
    try {
      void open(droppedPdf(event.dataTransfer), "file");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Drop exactly one PDF file.");
      restoreFocus("file");
    }
  };

  return <main className="static-launcher">
    <section
      className="static-launcher__card"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <div className="static-launcher__brand">
        <img
          className="static-launcher__mark"
          src={PLACEKEEPER_ICON_URL}
          alt=""
          width="30"
          height="30"
        />
        <h1>Placekeeper</h1>
      </div>
      <input
        ref={inputRef}
        id={inputId}
        className="static-launcher__input"
        type="file"
        accept="application/pdf,.pdf"
        disabled={pending}
        onChange={onChange}
      />
      <button
        ref={chooseButtonRef}
        type="button"
        className="static-launcher__button"
        disabled={pending}
        onClick={() => inputRef.current?.click()}
      >
        <ReviewIcon name="upload" size={14} />
        Upload PDF
      </button>
      <div className="static-launcher__separator"><span>or</span></div>
      <form className="static-launcher__url" onSubmit={(event) => {
        event.preventDefault();
        void open(remoteUrl.trim(), "url");
      }}>
        <div>
          <input
            ref={urlInputRef}
            id={`${inputId}-url`}
            type="url"
            aria-label="PDF URL"
            inputMode="url"
            autoComplete="off"
            placeholder="https://example.org/paper.pdf"
            value={remoteUrl}
            disabled={pending}
            onChange={(event) => setRemoteUrl(event.currentTarget.value)}
          />
          <button type="submit" disabled={pending || remoteUrl.trim() === ""}>
            <ReviewIcon name="link" size={14} />
            Open
          </button>
        </div>
      </form>
      <p className="static-launcher__durability">
        Annotations must be exported manually in this browser version. For autosave, <a
          href="https://github.com/brad-ross/placekeeper#install"
          target="_blank"
          rel="noreferrer noopener"
        >download the local version</a>.
      </p>
      {pending ? <div className="static-launcher__progress">
        <p role="status" aria-live="polite">{OPENING_STATUS[phase]}</p>
        <button type="button" onClick={() => operationRef.current?.abort()}>Cancel</button>
      </div> : null}
      {error === undefined ? null : <p className="static-launcher__error" role="alert" tabIndex={-1}>{error}</p>}
    </section>
  </main>;
}

async function staticEnvironmentFailure(): Promise<string | undefined> {
  if (window.self !== window.top) {
    return "Placekeeper cannot run inside another page. Open this page in its own tab.";
  }
  if (window.opener !== null) {
    return "Placekeeper cannot start from a tab that can control this page. Open the address in a new independent tab.";
  }
  const serviceWorker = window.navigator.serviceWorker;
  if (serviceWorker === undefined) return undefined;
  if (serviceWorker.controller !== null) {
    return "Placekeeper cannot run while a service worker controls this page. Clear site data, then reopen it.";
  }
  const pageUrl = new URL(document.baseURI);
  let registrations: readonly ServiceWorkerRegistration[];
  try {
    registrations = await serviceWorker.getRegistrations();
  } catch {
    return "Placekeeper could not confirm that this page is free from service-worker control. Try a private browser window.";
  }
  if (registrations.some((registration) => pageUrl.href.startsWith(registration.scope))) {
    return "Placekeeper cannot run under a registered service worker. Clear site data, then reopen it.";
  }
  return undefined;
}

function renderStaticFailure(rootElement: HTMLElement, message: string): void {
  rootElement.replaceChildren();
  const main = document.createElement("main");
  main.className = "static-launcher";
  const section = document.createElement("section");
  section.className = "static-launcher__card";
  const heading = document.createElement("h1");
  heading.textContent = "Placekeeper did not start";
  const detail = document.createElement("p");
  detail.className = "static-launcher__error";
  detail.setAttribute("role", "alert");
  detail.textContent = message;
  section.append(heading, detail);
  main.append(section);
  rootElement.append(main);
}

export async function mountStaticBrowserApp(): Promise<void> {
  const rootElement = document.querySelector("#root");
  if (!(rootElement instanceof HTMLElement)) throw new Error("Placekeeper root is unavailable.");
  const environmentFailure = await staticEnvironmentFailure();
  if (environmentFailure !== undefined) {
    renderStaticFailure(rootElement, environmentFailure);
    return;
  }
  const launcher = createRoot(rootElement);
  const pdfiumWasmUrl = new URL(PDFIUM_WASM_ASSET, document.baseURI).href;
  const pdfiumWorkerUrl = new URL(PDFIUM_WORKER_ASSET, document.baseURI).href;
  let activationEpoch = 0;

  launcher.render(<StaticLauncher onOpen={async (input, operation) => {
    const epoch = ++activationEpoch;
    const source = typeof input === "string"
      ? await readStaticPdfUrl(input, fetch, { signal: operation.signal })
      : await readStaticPdfFile(input, operation.signal);
    operation.onPhase("assessing");
    const runtime = await createStaticHostRuntime({
      source,
      viewerAssets: { pdfiumWasm: pdfiumWasmUrl, workerUrl: pdfiumWorkerUrl },
    }, {
      signal: operation.signal,
    });
    operation.onPhase("activating");

    const reviewRoot = document.createElement("div");
    reviewRoot.className = "static-review-root static-review-root--activating";
    document.body.append(reviewRoot);
    const ready = Promise.withResolvers<void>();
    let unmount: (() => void) | undefined;
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      unmount?.();
      runtime.dispose();
      reviewRoot.remove();
    };
    try {
      unmount = await startRuntime(runtime, {
        rootElement: reviewRoot,
        onDocumentReady: () => ready.resolve(),
        onRuntimeError: (error) => ready.reject(error),
      });
      await waitForActivation(ready.promise, operation.signal);
      if (epoch !== activationEpoch || operation.signal.aborted) throw cancelledOpening();
    } catch (error) {
      dispose();
      throw error;
    }

    launcher.unmount();
    rootElement.remove();
    reviewRoot.id = "root";
    reviewRoot.classList.remove("static-review-root--activating");
    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      globalThis.removeEventListener("pagehide", onPageHide);
      dispose();
    };
    globalThis.addEventListener("pagehide", onPageHide);
  }} />);
}

if (typeof document !== "undefined") void mountStaticBrowserApp();
