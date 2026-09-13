import { useRef, useState, type RefObject } from "react";

// Keep this browser literal equal to scripts/package-source-release.ts (unit-tested).
export const SOURCE_INSTALL_COMMAND = `( set -eu; d=$(mktemp -d "\${TMPDIR:-/tmp}/placekeeper-bootstrap.XXXXXX"); trap 'rm -rf "$d"' EXIT; trap 'exit 130' INT; trap 'exit 143' TERM; curl --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 180 --retry 2 https://github.com/brad-ross/placekeeper/releases/latest/download/install-placekeeper.sh -o "$d/install.sh" || { printf '%s\\n' 'A stable Placekeeper installer is unavailable. Check your connection and published releases, then retry.' >&2; exit 1; }; /bin/sh "$d/install.sh" )`;

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
      <button type="button" autoFocus aria-label="Close installation dialog" onClick={() => dialogRef.current?.close()}>×</button>
    </header>
    <p>Get the Mac app, then choose your integrations. Run this command again to update or add integrations later.</p>
    <p className="install-dialog__requirements">Apple silicon Mac · macOS 13+ runtime. Building requires working Swift 6+ and a macOS SDK from Apple’s <a href="https://developer.apple.com/documentation/xcode/installing-the-command-line-tools" target="_blank" rel="noreferrer noopener">Command Line Tools</a>; this may require a newer macOS.</p>
    <pre className="install-dialog__command" tabIndex={0} aria-label="Install command"><code>{SOURCE_INSTALL_COMMAND}</code></pre>
    <div className="install-dialog__footer">
      <button type="button" className="install-dialog__copy" onClick={async () => {
        const current = generation.current;
        try {
          await navigator.clipboard.writeText(SOURCE_INSTALL_COMMAND);
          if (current === generation.current) setStatus("Command copied.");
        } catch {
          if (current === generation.current) setStatus("Couldn’t copy. Select the command and copy it manually.");
        }
      }}>Copy command</button>
      <span role="status" aria-live="polite">{status}</span>
    </div>
  </dialog>;
}
