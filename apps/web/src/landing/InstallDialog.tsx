import { useRef, useState, type RefObject } from "react";

// Keep this browser literal equal to scripts/package-source-release.ts (unit-tested).
export const SOURCE_INSTALL_COMMAND = "curl -fsSL https://brad-ross.github.io/placekeeper/install.sh | sh";

export function InstallDialog({ dialogRef, onClose }: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly onClose: () => void;
}) {
  const [status, setStatus] = useState("");
  const generation = useRef(0);
  const backdropPress = useRef(false);
  const outside = (event: { clientX: number; clientY: number }) => {
    const bounds = dialogRef.current!.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  };
  return <dialog ref={dialogRef} className="install-dialog" aria-labelledby="install-dialog-title"
    onKeyDown={(event) => {
      if (event.key === "Escape") event.stopPropagation();
      if (event.key !== "Tab") return;
      const controls = event.currentTarget.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]');
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onClose={() => { generation.current += 1; setStatus(""); onClose(); }}
    onPointerDown={(event) => { backdropPress.current = event.target === event.currentTarget && outside(event); }}
    onClick={(event) => {
      if (backdropPress.current && event.target === event.currentTarget && outside(event)) dialogRef.current?.close();
      backdropPress.current = false;
    }}>
    <header className="install-dialog__header">
      <h2 id="install-dialog-title">Install Placekeeper</h2>
    </header>
    <p>Run the command below to install the Mac app and optionally install integrations. You can run it again to install integrations and update the app later.</p>
    <button type="button" className="install-dialog__command" autoFocus aria-label="Copy command" title="Copy command" onClick={async () => {
        if (window.getSelection()?.toString()) return;
        const current = generation.current;
        try {
          await navigator.clipboard.writeText(SOURCE_INSTALL_COMMAND);
          if (current === generation.current) setStatus("Command copied.");
        } catch {
          if (current === generation.current) setStatus("Couldn’t copy. Select the command and copy it manually.");
        }
      }}>
      <code aria-label="Install command">{SOURCE_INSTALL_COMMAND}</code>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></svg>
    </button>
    <div className="install-dialog__footer">
      <span role="status" aria-live="polite">{status}</span>
    </div>
  </dialog>;
}
