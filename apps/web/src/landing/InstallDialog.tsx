import { useRef, useState, type RefObject } from "react";
import { ALL_DOWNLOADS_URL, DESKTOP_TARGETS, RELEASE_REPOSITORY, type DesktopTarget } from '../../../../packages/core/src/desktop-release.js';
import type { Downloads } from './downloads.js';

const INSTALLATION_GUIDE = `${RELEASE_REPOSITORY}/blob/main/docs/installation.md`;

// Keep this browser literal equal to scripts/package-source-release.ts (unit-tested).
export const SOURCE_INSTALL_COMMAND = "curl -fsSL https://brad-ross.github.io/placekeeper/install.sh | sh";

export function InstallDialog({ dialogRef, onClose, downloads, target }: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly onClose: () => void;
  readonly downloads: Downloads;
  readonly target: DesktopTarget | undefined;
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
      <button type="button" autoFocus onClick={() => dialogRef.current?.close()}>Close</button>
    </header>
    <section aria-label="Desktop downloads">
      {downloads.status === 'loading' ? <p>Checking published desktop downloads…</p> : downloads.status === 'unavailable' ? <p>Desktop downloads are unavailable or the latest release does not contain the complete installer set. Check all releases or build from source below. Historical release 0.2.4 provides only Apple Silicon Mac source installation.</p> : <>
        <p>Placekeeper {downloads.catalog.version}. Desktop installers include their runtime; no Node.js, pnpm, or compiler is needed.</p>
        {target ? <p><a className="landing-download" href={downloads.catalog.downloads[target].url}>Download for {DESKTOP_TARGETS[target].label}</a></p> : <p>Choose your computer below. On a Mac, check Apple menu → About This Mac for Chip (Apple Silicon) or Processor (Intel). Mobile and other platforms can use the web reader.</p>}
        <ul className="install-dialog__downloads">{(Object.keys(DESKTOP_TARGETS) as DesktopTarget[]).map(key => <li key={key}><a href={downloads.catalog.downloads[key].url}>{DESKTOP_TARGETS[key].label}</a></li>)}</ul>
        <p><a href={downloads.catalog.notesUrl}>Release notes</a> · <a href={downloads.catalog.checksumsUrl}>SHA256 checksums</a> · <a href={downloads.catalog.source.shellUrl}>Shell source installer</a> · <a href={downloads.catalog.source.powershellUrl}>PowerShell source installer</a>{downloads.catalog.source.archiveUrl ? <> · <a href={downloads.catalog.source.archiveUrl}>Source archive</a></> : null}</p>
      </>}
      <p><a href={ALL_DOWNLOADS_URL}>All releases and platforms</a> · <a href={INSTALLATION_GUIDE}>Installation and unsigned approval guide</a> · <a href={`${RELEASE_REPOSITORY}/blob/main/docs/desktop-upgrades.md`}>Upgrades and recovery</a></p>
      <p>Use the installer app inside the Mac DMG, Windows Setup.exe, or the Debian package. Unsigned OS approval guidance is provisional pending downloaded-artifact testing. If policy blocks installation, ask your administrator; source builds are subject to the same policy.</p>
    </section>
    <section aria-label="Source installation">
    <h3>Build from source</h3>
    <p>The current checkout requires Node.js 24+, pnpm 11.16.0 and a C compiler; Windows needs Visual Studio C++ tools and Developer PowerShell. Run <code>./install.sh</code> on macOS/Linux or <code>./install.ps1</code> on Windows from the checkout. See <a href={INSTALLATION_GUIDE}>source prerequisites and sandbox requirements</a>. SyncTeX separately requires a native TeX installation.</p>
    <p>The source bootstrap below follows the latest published stable release. Review that release’s prerequisites before running it. Historical <a href={`${RELEASE_REPOSITORY}/releases/tag/v0.2.4`}>0.2.4</a> supplies only the older AppKit source route for Apple Silicon Macs; it is not an Electron desktop installer.</p>
    <button type="button" className="install-dialog__command" aria-label="Copy command" title="Copy command" onClick={async () => {
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
    </section>
    <p>Alternatively, use the web reader on this page for non-confidential PDFs. Export is the only way to keep your changes; it has no autosave or reload recovery, desktop integrations, or local-service recovery.</p>
    <div className="install-dialog__footer">
      <span role="status" aria-live="polite">{status}</span>
    </div>
  </dialog>;
}
