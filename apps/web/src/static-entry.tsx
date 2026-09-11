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
import "./static-entry.css";

// The static Vite plugin replaces these with content-addressed Rollup asset URLs.
const PDFIUM_WASM_ASSET = "__PLACEKEEPER_STATIC_PDFIUM_WASM__";
const PDFIUM_WORKER_ASSET = "__PLACEKEEPER_STATIC_PDFIUM_WORKER__";
const PLACEKEEPER_ICON_URL = new URL("../../../packaging/macos/icon/Placekeeper.svg", import.meta.url).href;

const REPOSITORY_URL = "https://github.com/brad-ross/placekeeper";
const INSTALL_URL = `${REPOSITORY_URL}#install`;

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

  return <main className="static-launcher" onKeyDown={(event) => {
    if (event.key === "Escape" && pending) operationRef.current?.abort();
  }}>
    {error === undefined ? null : <div className="review-toast-stack static-launcher__toasts">
      <aside className="review-toast review-toast--error" role="alert"><ReviewIcon name="alert" /><span>{error}</span></aside>
    </div>}
    <header className="landing-nav">
      <a className="static-launcher__brand" href="#top" aria-label="Placekeeper home">
        <img className="static-launcher__mark" src={PLACEKEEPER_ICON_URL} alt="" width="42" height="42" />
        <span>Placekeeper</span>
      </a>
      <nav aria-label="Main navigation"><a href="#features">Explore the app</a><a href={REPOSITORY_URL} target="_blank" rel="noreferrer noopener">GitHub <ReviewIcon name="open-main" size={13} /></a><a className="landing-nav__try" href="#try">Try Placekeeper <ReviewIcon name="arrow-right" size={14} /></a></nav>
    </header>
    <div className="landing-hero" id="top">
      <section className="landing-hero__copy" aria-labelledby="landing-title">
        <p className="landing-eyebrow"><span className="landing-dot" /> A focused PDF reader &amp; annotator</p>
        <h1 id="landing-title"><span className="sr-only">Placekeeper: </span>Follow the thought.<br /><span>Keep your place.</span></h1>
        <p className="landing-hero__description">For the passages you underline, the questions you leave in the margin, and the references worth following. A calmer space to read closely.</p>
        <div className="landing-hero__details"><span><ReviewIcon name="file" size={15} /> Your PDF, in your browser</span><span><ReviewIcon name="check" size={15} /> No account needed</span></div>
      </section>
      <section id="try" aria-labelledby="try-title" className="static-launcher__card" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        <header>
          <span className="landing-eyebrow">Try it with your own PDF</span>
          <h2 id="try-title">Your next good read starts here.</h2>
          <p className="static-launcher__description">Open a local file or a public PDF link.</p>
        </header>
        <div className="landing-open-controls">
        <input
          ref={inputRef}
          id={inputId}
          className="static-launcher__input"
          type="file"
          title="Choose a PDF"
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
              title="PDF URL"
              aria-label="PDF URL"
              inputMode="url"
              autoComplete="off"
              placeholder="https://example.org/paper.pdf"
              value={remoteUrl}
              disabled={pending}
              onChange={(event) => setRemoteUrl(event.currentTarget.value)}
            />
            <button type="submit" title={pending && openingSource === "url" ? "Cancel opening" : "Open PDF URL"} disabled={pending ? openingSource !== "url" : remoteUrl.trim() === ""}>
              <ReviewIcon name={pending && openingSource === "url" ? "loading" : "link"} size={14} className={pending && openingSource === "url" ? "review-icon static-launcher__spinner" : "review-icon"} />
              Open
            </button>
          </div>
        </form>
        <p className="landing-drop-hint">Or drop a PDF anywhere in this box.</p>
        {pending ? <p className="sr-only" role="status" aria-live="polite">{OPENING_STATUS[phase]}</p> : null}
      </div>
      <p className="landing-export-note"><ReviewIcon name="info" size={15} /><span>Annotations must be exported manually in this browser version. For autosave, <a href={INSTALL_URL} target="_blank" rel="noreferrer noopener">download the local version</a>.</span></p>
    </section>
    </div>
    <ProductShowcase />
    <section className="landing-features" aria-labelledby="workflow-title">
      <div className="landing-section-heading"><p className="landing-eyebrow">Built around the way you read</p><h2 id="workflow-title">Keep the context.<br />Make room for the idea.</h2><p>A PDF is more than a stack of pages. Move through its argument, work in the margins, and bring your thoughts back with you.</p></div>
      <div className="landing-feature-grid">
        <article><span className="landing-feature-icon"><ReviewIcon name="outline" size={21} /></span><h3>Find your way through.</h3><p>Jump through the outline or search for a phrase. Move between passages without turning reading into a hunt.</p><span className="landing-feature-detail">Outline &amp; document search</span></article>
        <article><span className="landing-feature-icon landing-feature-icon--yellow"><ReviewIcon name="highlight" size={21} /></span><h3>Leave a useful margin.</h3><p>Highlight what matters. Add comments, suggest replacements, or leave a page note. Review your annotations together.</p><span className="landing-feature-detail">Highlights, comments &amp; edits</span></article>
        <article><span className="landing-feature-icon landing-feature-icon--blue"><ReviewIcon name="references" size={21} /></span><h3>Take the detour.</h3><p>Open linked passages in a reference workspace. Follow another connection while your main reading position stays in view.</p><span className="landing-feature-detail">References alongside your reading</span></article>
      </div>
    </section>
    <section className="landing-export" aria-labelledby="export-title">
      <div className="landing-export__visual" aria-hidden="true"><div><ReviewIcon name="file" size={32} /><span>paper.pdf</span></div><ReviewIcon name="arrow-right" size={22} /><div><ReviewIcon name="annotations" size={32} /><span>reviewed.pdf</span><span className="landing-export__check"><ReviewIcon name="check" size={12} /></span></div></div>
      <div><p className="landing-eyebrow">Your thinking, to go</p><h2 id="export-title">Close the loop.<br />Keep the marked-up copy.</h2><p>Export a reviewed PDF with your annotations. Open that copy in Placekeeper again to keep working with your Placekeeper notes and edits.</p><p className="landing-export__reminder">In the browser, export before you close or reload. There’s no autosave.</p></div>
    </section>
    <section className="landing-faq" aria-labelledby="details-title"><h2 id="details-title">A few things to know.</h2><div>
      <details><summary>Does my local PDF get uploaded?<ReviewIcon name="plus" size={16} /></summary><p>Local files are processed in your browser, without uploading the PDF to a Placekeeper server. Use non-confidential documents with this web beta. <a href="./privacy.html">Read the browser privacy details</a>.</p></details>
      <details><summary>Which PDF links can I open?<ReviewIcon name="plus" size={16} /></summary><p>Use a direct, public HTTPS link to a PDF. The website must allow access from another site. If a link won’t open, download the PDF and open the local file instead. Opening a link sends a request to that website.</p></details>
      <details><summary>How do I save my work?<ReviewIcon name="plus" size={16} /></summary><p>Choose Export in the document menu to download a reviewed copy. Export is the only way to keep changes in this browser version; closing or reloading the page loses unexported work.</p></details>
      <details><summary>What does the local app add?<ReviewIcon name="plus" size={16} /></summary><p>The local Mac app adds autosave and recovery, with optional Chrome, VS Code, and Codex integrations. <a href={INSTALL_URL} target="_blank" rel="noreferrer noopener">See installation instructions</a>.</p></details>
    </div></section>
    <section className="landing-closing"><img src={PLACEKEEPER_ICON_URL} alt="" width="56" height="56" /><h2>Pick up a PDF.<br />See where it takes you.</h2><a href="#try">Try Placekeeper <ReviewIcon name="arrow-right" size={16} /></a></section>
    <footer className="landing-footer"><span>Placekeeper <span>· A little more room to think.</span></span><div><a href="./privacy.html">Privacy</a><a href="./third-party-notices.html">Notices</a><a href={REPOSITORY_URL} target="_blank" rel="noreferrer noopener">Source on GitHub</a></div></footer>
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
