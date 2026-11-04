import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { RELEASE_REPOSITORY, type DesktopTarget } from '../../../../packages/core/src/desktop-release.js';
import { ReviewIcon } from '../review/ReviewIcon.js';
import type { Downloads } from './downloads.js';

const PLATFORM_LABELS: Record<DesktopTarget, string> = {
  'darwin-arm64': 'macOS Apple Silicon',
  'darwin-x64': 'macOS Intel',
  'win32-x64': 'Windows x64',
  'linux-x64': 'Linux Debian / Ubuntu x64',
};

export function DownloadButton({ downloads, target }: {
  readonly downloads: Downloads;
  readonly target: DesktopTarget | undefined;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLAnchorElement | HTMLButtonElement | null>(null);
  const invokerRef = useRef<HTMLAnchorElement | HTMLButtonElement | null>(null);
  const artifact = downloads.status === 'available' && target ? downloads.catalog.downloads[target] : undefined;
  const toggle = (invoker: HTMLButtonElement) => {
    invokerRef.current = invoker;
    setOpen(value => !value);
  };

  // Catalog arrival can replace the invoking button with its download anchor.
  useLayoutEffect(() => {
    const invoker = invokerRef.current;
    if (!open || !invoker || invoker.isConnected) return;
    invokerRef.current = mainRef.current;
    if (document.activeElement === document.body) mainRef.current?.focus({ preventScroll: true });
  }, [artifact, open]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [open]);

  return <div className="landing-download" ref={rootRef}
    onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}
    onKeyDown={event => {
      if (event.key !== 'Escape' || !open) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      invokerRef.current?.focus({ preventScroll: true });
    }}>
    <div className="landing-download__segments">
      {artifact && target ? <a className="landing-download__main" ref={element => { mainRef.current = element; }} href={artifact.url}>
        <ReviewIcon name="download" size={18} /><span>Download for {PLATFORM_LABELS[target]}</span>
      </a> : <button className="landing-download__main" ref={element => { mainRef.current = element; }} type="button" aria-expanded={open} aria-controls={panelId} onClick={event => toggle(event.currentTarget)}>
        <ReviewIcon name="download" size={18} /><span>Download Placekeeper</span>
      </button>}
      <button className="landing-download__toggle" type="button" aria-label="Other download options" aria-expanded={open} aria-controls={panelId} onClick={event => toggle(event.currentTarget)}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m6 9 6 6 6-6" /></svg>
      </button>
    </div>
    <nav id={panelId} className="landing-download__panel" aria-label="Placekeeper downloads" hidden={!open}>
      <ul className="landing-download__platforms">
        {(Object.keys(PLATFORM_LABELS) as DesktopTarget[]).map(key => <li key={key}>
          {downloads.status === 'available' ? <a href={downloads.catalog.downloads[key].url}>{PLATFORM_LABELS[key]}<ReviewIcon name="download" size={15} /></a> : <span aria-disabled="true">{PLATFORM_LABELS[key]}</span>}
        </li>)}
      </ul>
      {downloads.status === 'available' ? null : <p className="landing-download__status" role="status">{downloads.status === 'loading' ? 'Checking downloads…' : 'Downloads unavailable'}</p>}
      <ul className="landing-download__more">
        <li><a href={`${RELEASE_REPOSITORY}/blob/main/docs/installation.md`}>Build from source<ReviewIcon name="arrow-right" size={15} /></a></li>
        <li><a href={`${RELEASE_REPOSITORY}/releases`}>All releases<ReviewIcon name="arrow-right" size={15} /></a></li>
      </ul>
    </nav>
  </div>;
}
