import { useRef, useState } from 'react';

import {
  encodePlacekeeperLinkFragment,
  type PlacekeeperLinkLocation,
} from '../../../../packages/core/src/placekeeper-link.js';
import { ReviewIcon } from './ReviewIcon.js';

export type CopyLinkStatus =
  | { readonly status: 'idle' | 'pending' | 'success' }
  | { readonly status: 'failure'; readonly link: string };

export function buildPlacekeeperCopyLink(
  appLinkBase: string,
  location: PlacekeeperLinkLocation,
): string {
  if (!appLinkBase.startsWith('placekeeper:///') || appLinkBase.includes('#') || appLinkBase.includes('?')) {
    throw new Error('Placekeeper app-link base is invalid');
  }
  return `${appLinkBase}#${encodePlacekeeperLinkFragment(location)}`;
}

export function createCopyLinkCommand(input: {
  readonly getLink: () => string;
  readonly writeText: (link: string) => Promise<void>;
  readonly onStatus: (status: CopyLinkStatus) => void;
}): { readonly run: (linkOverride?: string) => Promise<void> } {
  let pending: Promise<void> | null = null;
  return {
    run: (linkOverride) => {
      if (pending !== null) return pending;
      const link = linkOverride ?? input.getLink();
      input.onStatus({ status: 'pending' });
      pending = input.writeText(link)
        .then(() => input.onStatus({ status: 'success' }))
        .catch(() => input.onStatus({ status: 'failure', link }))
        .finally(() => { pending = null; });
      return pending;
    },
  };
}

export interface CopyLinkControlProps {
  readonly getLink: () => string;
  readonly writeText: (link: string) => Promise<void>;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
  readonly title?: string;
  readonly variant?: 'chrome' | 'annotation';
}

export function CopyLinkControl({
  getLink,
  writeText,
  disabled = false,
  ariaLabel = 'Copy link to current PDF location',
  title = 'Copy link',
  variant = 'chrome',
}: CopyLinkControlProps) {
  const getLinkRef = useRef(getLink);
  getLinkRef.current = getLink;
  const writeTextRef = useRef(writeText);
  writeTextRef.current = writeText;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState<CopyLinkStatus>({ status: 'idle' });
  const commandRef = useRef<ReturnType<typeof createCopyLinkCommand> | null>(null);
  if (commandRef.current === null) {
    commandRef.current = createCopyLinkCommand({
      getLink: () => getLinkRef.current(),
      writeText: (link) => writeTextRef.current(link),
      onStatus: (next) => {
        setStatus(next);
        if (next.status === 'failure') queueMicrotask(() => triggerRef.current?.focus());
      },
    });
  }
  const run = () => { void commandRef.current?.run(); };
  const annotation = variant === 'annotation';

  return (
    <div
      className={`copy-link-control${annotation ? ' copy-link-control--annotation' : ''}`}
      data-copy-link-status={status.status}
    >
      <button
        ref={triggerRef}
        type="button"
        className={annotation
          ? 'annotation-item__action copy-link-control__trigger'
          : 'review-chrome__icon-control copy-link-control__trigger'}
        {...(annotation ? { 'data-annotation-action': 'copy-link' } : {})}
        aria-label={ariaLabel}
        title={title}
        aria-busy={status.status === 'pending' ? 'true' : 'false'}
        disabled={disabled || status.status === 'pending'}
        onClick={run}
      >
        <ReviewIcon name="clipboard" />
      </button>
      {status.status === 'success' ? (
        <span className="copy-link-control__status" role="status">Link copied.</span>
      ) : null}
      {status.status === 'failure' ? (
        <div className="copy-link-control__fallback">
          <p role="alert">Clipboard access failed. Copy the link below.</p>
          <input
            aria-label="Placekeeper link"
            title="Placekeeper link"
            readOnly
            value={status.link}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            title="Retry copying link"
            disabled={disabled}
            onClick={() => { void commandRef.current?.run(status.link); }}
          >Retry</button>
        </div>
      ) : null}
    </div>
  );
}
