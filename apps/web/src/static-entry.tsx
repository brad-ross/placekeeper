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
import { ProductShowcase } from "./landing/ProductShowcase.js";
import { SurfaceShowcase } from "./landing/SurfaceShowcase.js";
import "./static-entry.css";

// The static Vite plugin replaces these with content-addressed Rollup asset URLs.
const PDFIUM_WASM_ASSET = "__PLACEKEEPER_STATIC_PDFIUM_WASM__";
const PDFIUM_WORKER_ASSET = "__PLACEKEEPER_STATIC_PDFIUM_WORKER__";
const PLACEKEEPER_ICON_URL = new URL("../../../packaging/macos/icon/Placekeeper.svg", import.meta.url).href;

const REPOSITORY_URL = "https://github.com/brad-ross/placekeeper";

const ACTIVATION_TIMEOUT_MS = 30_000;

type OpeningPhase = "idle" | "acquiring" | "assessing" | "activating";
type SourceControl = "file" | "url";

const OPENING_STATUS: Readonly<Record<Exclude<OpeningPhase, "idle">, string>> = {
  acquiring: "Reading the document…",
  assessing: "Checking whether this document can be safely annotated…",
  activating: "Preparing the document viewer…",
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
      "The document viewer took too long to become ready. Try opening the document again.",
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
    throw new Error("Drop exactly one document file, not a folder or multiple files.");
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
  const [openingSource, setOpeningSource] = useState<SourceControl>();
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
    setOpeningSource(control);
    setPhase("acquiring");
    setError(undefined);
    try {
      await props.onOpen(source, {
        signal: controller.signal,
        onPhase: setPhase,
      });
    } catch (cause) {
      if (!isStaticOperationCancelled(cause) && !(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "This document could not be opened.");
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
      setError(cause instanceof Error ? cause.message : "Drop exactly one document file.");
      restoreFocus("file");
    }
  };

  return <main className="static-launcher" onKeyDown={(event) => {
    if (event.key === "Escape" && pending) operationRef.current?.abort();
  }}>
    {error === undefined ? null : <div className="review-toast-stack static-launcher__toasts">
      <aside className="review-toast review-toast--error" role="alert"><ReviewIcon name="alert" /><span>{error}</span></aside>
    </div>}
    <div className="landing-hero" id="top">
      <section className="landing-hero__copy" aria-labelledby="landing-title">
        <div className="static-launcher__brand">
          <img className="static-launcher__mark" src={PLACEKEEPER_ICON_URL} alt="" width="96" height="96" />
          <h1 id="landing-title">Placekeeper</h1>
        </div>
        <p className="landing-hero__description">A focused document reader for following references and making comments.</p>
        <div className="landing-hero__actions">
        <a className="landing-download" href="#install"><ReviewIcon name="download" size={18} /> Install</a>
        <a className="landing-github" href={REPOSITORY_URL} target="_blank" rel="noreferrer noopener">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.3c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.8.1-.8.1-.8 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.8 18.3 5 18.3 5c.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.6c0 .3.2.7.8.6A12 12 0 0 0 12 .3Z" /></svg>
          GitHub
        </a>
        </div>
      </section>
      <section id="try" aria-labelledby="try-title" className="static-launcher__card" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        <header>
          <h2 id="try-title">Try it with your own document</h2>
        </header>
        <div className="landing-open-controls">
        <input
          ref={inputRef}
          id={inputId}
          className="static-launcher__input"
          type="file"
          title="Choose a document"
          accept="application/pdf,.pdf"
          disabled={pending}
          onChange={onChange}
        />
        <button
          ref={chooseButtonRef}
          type="button"
          title={pending && openingSource === "file" ? "Cancel opening" : "Upload PDF"}
          className="static-launcher__button"
          disabled={pending && openingSource !== "file"}
          onClick={() => pending ? operationRef.current?.abort() : inputRef.current?.click()}
        >
          <ReviewIcon name={pending && openingSource === "file" ? "loading" : "upload"} size={14} className={pending && openingSource === "file" ? "review-icon static-launcher__spinner" : "review-icon"} />
          Upload PDF
        </button>
        <p className="landing-drop-hint">Or drop a document here</p>
        <div className="static-launcher__separator"><span>or</span></div>
        <form className="static-launcher__url" onSubmit={(event) => {
          event.preventDefault();
          if (pending) operationRef.current?.abort();
          else void open(remoteUrl.trim(), "url");
        }}>
          <div>
            <input
              ref={urlInputRef}
              id={`${inputId}-url`}
              type="url"
              title="Document URL"
              aria-label="Document URL"
              inputMode="url"
              autoComplete="off"
              placeholder="https://example.org/paper.pdf"
              value={remoteUrl}
              disabled={pending}
              onChange={(event) => setRemoteUrl(event.currentTarget.value)}
            />
            <button type="submit" title={pending && openingSource === "url" ? "Cancel opening" : "Open document URL"} disabled={pending ? openingSource !== "url" : remoteUrl.trim() === ""}>
              <ReviewIcon name={pending && openingSource === "url" ? "loading" : "link"} size={14} className={pending && openingSource === "url" ? "review-icon static-launcher__spinner" : "review-icon"} />
              Open
            </button>
          </div>
        </form>
        {pending ? <p className="sr-only" role="status" aria-live="polite">{OPENING_STATUS[phase]}</p> : null}
      </div>
    </section>
    </div>
    <ProductShowcase />
    <section className="landing-extras" aria-labelledby="more-features-title">
      <h2 id="more-features-title">More ways to work with your document</h2>
      <article><span className="landing-symbol" aria-hidden="true">∑</span><div><h3>Symbol search</h3><p>Find mathematical symbols by name or LaTeX command.</p></div></article>
      <article><ReviewIcon name="lock" size={20} /><div><h3>Horizontal scroll lock</h3><p>Keep the page steady while scrolling a zoomed-in document.</p></div></article>
      <article><ReviewIcon name="undo" size={20} /><div><h3>Document history</h3><p>Go back and forward through places you’ve visited.</p></div></article>
      <article><ReviewIcon name="download" size={20} /><div><h3>Portable annotations</h3><p>Export your comments and reopen them to keep editing.</p></div></article>
    </section>
    <SurfaceShowcase />
    <section id="install" className="landing-invitations" aria-label="Get started with Placekeeper">
      <div>
        <h2>Make Placekeeper yours.</h2>
        <p>Get the Mac app and optional integrations.</p>
        <a className="landing-invitations__download" href={`${REPOSITORY_URL}/archive/refs/heads/main.zip`}><ReviewIcon name="download" size={16} /> Install</a>
      </div>
      <div>
        <h2>Or try your own document.</h2>
        <p>Open a file or document link here.</p>
        <a href="#try">Try it <ReviewIcon name="arrow-right" size={16} /></a>
      </div>
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

if (typeof document !== "undefined") {
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo === 'read' || demo === 'reference' || demo === 'annotate') {
    void import('./landing/demo-entry.js').then(({ mountLandingDemo }) => mountLandingDemo(demo, {
      pdfiumWasm: new URL(PDFIUM_WASM_ASSET, document.baseURI).href,
      workerUrl: new URL(PDFIUM_WORKER_ASSET, document.baseURI).href,
    })).catch(() => {
      const root = document.querySelector('#root');
      if (root) root.textContent = 'The demo could not load. Try refreshing the page.';
    });
  } else void mountStaticBrowserApp();
}
