import { useId, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { createRoot } from "react-dom/client";

import {
  createStaticHostRuntime,
  readStaticPdfFile,
  readStaticPdfUrl,
} from "./host/static-runtime.js";
import { startRuntime } from "./production-entry.js";
import "./static-entry.css";

const pdfiumWasm = new URL("./pdfium.wasm", document.baseURI).href;

function StaticLauncher(props: { readonly onOpen: (source: File | string) => Promise<void> }) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [remoteUrl, setRemoteUrl] = useState("");
  const open = async (source: File | string | undefined) => {
    if (source === undefined || (typeof source === "string" && source.trim() === "") || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await props.onOpen(source);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This PDF could not be opened.");
      setPending(false);
    }
  };
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    void open(event.currentTarget.files?.[0]);
    event.currentTarget.value = "";
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    void open(event.dataTransfer.files[0]);
  };

  return <main className="static-launcher">
    <section
      className="static-launcher__card"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <div className="static-launcher__mark" aria-hidden="true">P</div>
      <p className="static-launcher__eyebrow">Placekeeper for the web</p>
      <h1>Review a PDF without uploading it</h1>
      <p className="static-launcher__lede">
        Your PDF and annotations stay in this browser tab. Export a reviewed copy before closing or reloading.
      </p>
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
        type="button"
        className="static-launcher__button"
        disabled={pending}
        onClick={() => inputRef.current?.click()}
      >{pending ? "Opening PDF…" : "Choose a PDF"}</button>
      <p className="static-launcher__drop">or drop a PDF here · 64 MB maximum</p>
      <div className="static-launcher__separator"><span>or</span></div>
      <form className="static-launcher__url" onSubmit={(event) => {
        event.preventDefault();
        void open(remoteUrl.trim());
      }}>
        <label htmlFor={`${inputId}-url`}>PDF URL</label>
        <div>
          <input
            id={`${inputId}-url`}
            type="url"
            inputMode="url"
            placeholder="https://example.org/paper.pdf"
            value={remoteUrl}
            disabled={pending}
            onChange={(event) => setRemoteUrl(event.currentTarget.value)}
          />
          <button type="submit" disabled={pending || remoteUrl.trim() === ""}>Open URL</button>
        </div>
        <p>The PDF host must allow cross-origin browser access (CORS).</p>
      </form>
      {error === undefined ? null : <p className="static-launcher__error" role="alert">{error}</p>}
      <div className="static-launcher__privacy">
        <strong>Export-only preview</strong>
        <span>No autosave, accounts, uploads, or recovery after this tab closes.</span>
      </div>
    </section>
  </main>;
}

const rootElement = document.querySelector("#root");
if (!(rootElement instanceof HTMLElement)) throw new Error("Placekeeper root is unavailable.");
const launcher = createRoot(rootElement);
launcher.render(<StaticLauncher onOpen={async (input) => {
  const source = typeof input === "string"
    ? await readStaticPdfUrl(input)
    : await readStaticPdfFile(input);
  const runtime = await createStaticHostRuntime({ source, viewerAssets: { pdfiumWasm } });
  launcher.unmount();
  rootElement.replaceChildren();
  let unmount: () => void;
  try {
    unmount = await startRuntime(runtime);
  } catch (error) {
    runtime.dispose();
    throw error;
  }
  const onPageHide = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    globalThis.removeEventListener("pagehide", onPageHide);
    unmount();
    runtime.dispose();
  };
  globalThis.addEventListener("pagehide", onPageHide);
}} />);
