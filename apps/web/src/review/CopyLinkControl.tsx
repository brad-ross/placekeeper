import { useCallback, useRef, useState, type Ref } from 'react';

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
  readonly variant?: 'chrome' | 'annotation' | 'row' | 'popover';
  readonly presentation?: 'icon-only' | 'labeled';
  readonly buttonRole?: 'menuitem';
  readonly triggerRef?: Ref<HTMLButtonElement>;
  readonly feedbackPlacement?: 'floating' | 'inline';
}

function setRefValue<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref != null) ref.current = value;
}

function triggerClassName(
  variant: NonNullable<CopyLinkControlProps['variant']>,
  presentation: NonNullable<CopyLinkControlProps['presentation']>,
): string {
  const surfaceClass = variant === 'chrome'
    ? 'review-chrome__icon-control'
    : variant === 'annotation'
      ? 'annotation-item__action'
      : `copy-link-control__trigger--${variant}`;
  return `${surfaceClass} copy-link-control__trigger copy-link-control__trigger--${presentation}`;
}

export function CopyLinkControl({
  getLink,
  writeText,
  disabled = false,
  ariaLabel = 'Copy link to current PDF location',
  title = 'Copy link',
  variant = 'chrome',
  presentation = 'icon-only',
  buttonRole,
  triggerRef,
  feedbackPlacement = 'floating',
}: CopyLinkControlProps) {
  const getLinkRef = useRef(getLink);
  getLinkRef.current = getLink;
  const writeTextRef = useRef(writeText);
  writeTextRef.current = writeText;
  const internalTriggerRef = useRef<HTMLButtonElement>(null);
  const setTriggerNode = useCallback((node: HTMLButtonElement | null) => {
    internalTriggerRef.current = node;
    setRefValue(triggerRef, node);
  }, [triggerRef]);
  const [status, setStatus] = useState<CopyLinkStatus>({ status: 'idle' });
  const commandRef = useRef<ReturnType<typeof createCopyLinkCommand> | null>(null);
  if (commandRef.current === null) {
    commandRef.current = createCopyLinkCommand({
      getLink: () => getLinkRef.current(),
      writeText: (link) => writeTextRef.current(link),
      onStatus: (next) => {
        setStatus(next);
        if (next.status === 'failure') {
          queueMicrotask(() => internalTriggerRef.current?.focus({ preventScroll: true }));
        }
      },
    });
  }
  const run = () => { void commandRef.current?.run(); };
  const annotation = variant === 'annotation';
  const controlClassName = [
    'copy-link-control',
    `copy-link-control--${variant}`,
    `copy-link-control--feedback-${feedbackPlacement}`,
  ].join(' ');

  return (
    <div
      className={controlClassName}
      data-copy-link-status={status.status}
      {...(buttonRole === undefined ? {} : { role: 'presentation' as const })}
    >
      <button
        ref={setTriggerNode}
        type="button"
        className={triggerClassName(variant, presentation)}
        {...(annotation ? { 'data-annotation-action': 'copy-link' } : {})}
        {...(buttonRole === undefined ? {} : { role: buttonRole })}
        aria-label={ariaLabel}
        title={title}
        aria-busy={status.status === 'pending' ? 'true' : 'false'}
        disabled={disabled || status.status === 'pending'}
        onClick={run}
      >
        <ReviewIcon name="link" />
        {presentation === 'labeled' ? (
          <span className="copy-link-control__label">{ariaLabel}</span>
        ) : null}
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
