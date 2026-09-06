import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';

import type { PdfTargetVisibility } from '../pdf/viewer-navigation.js';
import { ReviewIcon } from './ReviewIcon.js';
import { ReviewTooltipButton } from './ReviewTooltipButton.js';

function composerIcon(title: string) {
  const normalized = title.toLocaleLowerCase();
  if (normalized.includes('replacement')) return 'replace' as const;
  if (normalized.includes('deletion')) return 'delete' as const;
  if (normalized.includes('insertion')) return 'insert' as const;
  if (normalized.includes('highlight')) return 'highlight' as const;
  if (normalized.includes('note')) return 'note' as const;
  return 'annotations' as const;
}

export interface CommentComposerAnchorNavigation {
  readonly visibility: PdfTargetVisibility;
  readonly pending: boolean;
  readonly onReturn: () => void;
  readonly pageNumber?: number;
}

export interface CommentComposerPlacement {
  readonly kind: 'side' | 'above' | 'below' | 'bottom-sheet';
  readonly style?: CSSProperties;
}

export interface CommentComposerProps {
  title: string;
  initialValue?: string;
  optional?: boolean;
  allowWhitespace?: boolean;
  fieldLabel?: string;
  saveLabel?: string;
  anchorNavigation?: CommentComposerAnchorNavigation | undefined;
  editorRef?: RefObject<HTMLTextAreaElement | null>;
  surfaceRef?: (element: HTMLElement | null) => void;
  placement?: CommentComposerPlacement;
  onValueChange?(value: string): void;
  onSave(value: string): void | Promise<void>;
  onSkip?: (() => void | Promise<void>) | undefined;
  onDismiss(): void | Promise<void>;
}

function AnchorReturn({ navigation }: {
  readonly navigation?: CommentComposerAnchorNavigation | undefined;
}) {
  const visibility = navigation?.visibility ?? 'unavailable';
  const state = navigation?.pending === true ? 'pending' : visibility;
  if (state !== 'outside' && state !== 'pending') return null;
  const label = state === 'pending' ? 'Returning to passage' : 'Back to passage';
  return (
    <ReviewTooltipButton
      className="comment-composer__anchor review-button review-button--secondary"
      type="button"
      label={label}
      data-return-state={state}
      disabled={state === 'pending'}
      onClick={() => navigation?.onReturn()}
    >
      <ReviewIcon name={state === 'pending' ? 'loading' : 'locate'} />
    </ReviewTooltipButton>
  );
}

export interface BoundedTextAreaHeightInput {
  readonly scrollHeight: number;
  readonly minHeight: number;
  readonly maxHeight: number;
}

export function boundedTextAreaHeight(input: BoundedTextAreaHeightInput): number {
  return Math.min(input.maxHeight, Math.max(input.minHeight, input.scrollHeight));
}

export function CommentComposer({
  title,
  initialValue = '',
  optional = false,
  allowWhitespace = false,
  fieldLabel = optional ? 'Comment (optional)' : 'Comment',
  saveLabel = 'Save',
  anchorNavigation,
  editorRef,
  surfaceRef,
  placement,
  onValueChange,
  onSave,
  onSkip,
  onDismiss,
}: CommentComposerProps) {
  const titleId = useId();
  const ownInputRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = editorRef ?? ownInputRef;
  const [value, setValue] = useState(initialValue);
  const [submitting, setSubmitting] = useState(false);
  const composingRef = useRef(false);
  const canSave = optional || (allowWhitespace ? value.length > 0 : value.trim().length > 0);
  const canSkip = optional && onSkip !== undefined;

  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }, [inputRef]);

  useLayoutEffect(() => {
    const editor = inputRef.current;
    const surface = editor?.closest<HTMLElement>('[data-comment-composer]');
    if (surface === null || surface === undefined) return;
    const viewport = globalThis.visualViewport;
    let editorFrame = 0;
    let viewportFrame = 0;
    const keepEditorVisible = () => {
      const body = surface.querySelector<HTMLElement>('.comment-composer__body');
      if (editor === null || body === null || document.activeElement !== editor) return;
      const editorRect = editor.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      if (editorRect.top < bodyRect.top) body.scrollTop -= bodyRect.top - editorRect.top;
      else if (editorRect.bottom > bodyRect.bottom) body.scrollTop += editorRect.bottom - bodyRect.bottom;
    };
    const scheduleEditorVisibility = () => {
      if (editorFrame !== 0) return;
      editorFrame = requestAnimationFrame(() => {
        editorFrame = 0;
        keepEditorVisible();
      });
    };
    const updateUsableHeight = () => {
      viewportFrame = 0;
      const host = surface.parentElement?.getBoundingClientRect();
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop
        + (viewport?.height ?? document.documentElement.clientHeight);
      const hostTop = Math.max(viewportTop, host?.top ?? viewportTop);
      const hostBottom = Math.min(viewportBottom, host?.bottom ?? viewportBottom);
      const usableHeight = `${Math.max(0, hostBottom - hostTop)}px`;
      const bottomOffset = `${Math.max(0, (host?.bottom ?? viewportBottom) - viewportBottom)}px`;
      if (surface.style.getPropertyValue('--comment-composer-usable-height') !== usableHeight) {
        surface.style.setProperty('--comment-composer-usable-height', usableHeight);
      }
      if (
        surface.style.getPropertyValue('--comment-composer-viewport-bottom-offset')
        !== bottomOffset
      ) {
        surface.style.setProperty('--comment-composer-viewport-bottom-offset', bottomOffset);
      }
      scheduleEditorVisibility();
    };
    const scheduleViewportUpdate = () => {
      if (viewportFrame !== 0) return;
      viewportFrame = requestAnimationFrame(updateUsableHeight);
    };
    updateUsableHeight();
    editor?.addEventListener('focus', scheduleEditorVisibility);
    window.addEventListener('resize', scheduleViewportUpdate);
    viewport?.addEventListener('resize', scheduleViewportUpdate);
    viewport?.addEventListener('scroll', scheduleViewportUpdate);
    return () => {
      cancelAnimationFrame(editorFrame);
      cancelAnimationFrame(viewportFrame);
      editor?.removeEventListener('focus', scheduleEditorVisibility);
      window.removeEventListener('resize', scheduleViewportUpdate);
      viewport?.removeEventListener('resize', scheduleViewportUpdate);
      viewport?.removeEventListener('scroll', scheduleViewportUpdate);
    };
  }, [inputRef]);

  useLayoutEffect(() => {
    const editor = inputRef.current;
    if (editor === null) return;
    editor.style.height = 'auto';
    const computed = getComputedStyle(editor);
    const minHeight = Number.parseFloat(computed.minHeight) || 84;
    const maxHeight = Number.parseFloat(computed.maxHeight) || 220;
    const height = boundedTextAreaHeight({ scrollHeight: editor.scrollHeight, minHeight, maxHeight });
    editor.style.height = `${height}px`;
    editor.style.overflowY = editor.scrollHeight > height ? 'auto' : 'hidden';
  }, [inputRef, value]);

  const submit = async () => {
    if (!canSave || submitting || composingRef.current) return;
    setSubmitting(true);
    try {
      await onSave(value);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      ref={surfaceRef}
      role="region"
      aria-labelledby={titleId}
      className="comment-composer compact-editorial-modal"
      data-comment-composer
      data-composer-placement={placement?.kind}
      style={placement?.style}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <header className="comment-composer__header compact-editorial-modal__header">
        <h2 id={titleId}><ReviewIcon name={composerIcon(title)} size={14} />{title}</h2>
        <div className="comment-composer__context">
          {anchorNavigation?.visibility === 'outside' && anchorNavigation.pageNumber !== undefined
            ? <span className="comment-composer__page-cue">{anchorNavigation.pageNumber}</span>
            : null}
          <AnchorReturn navigation={anchorNavigation} />
        </div>
      </header>
      <div className="comment-composer__body compact-editorial-modal__body">
        <label className="comment-composer__field">
          <span className="sr-only">{fieldLabel}</span>
          <textarea
            className="comment-composer__input"
            ref={inputRef}
            title={fieldLabel}
            value={value}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setValue(next);
              onValueChange?.(next);
            }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSave && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </label>
        <div className="comment-composer__actions">
          <button
            className="review-button review-button--secondary"
            type="button"
            title="Cancel"
            onClick={() => void onDismiss()}
          >
            <span>Cancel</span>
          </button>
          {canSkip ? (
            <button
              className="review-button review-button--secondary"
              type="button"
              title="Keep highlight without comment"
              onClick={() => void onSkip()}
            >
              <ReviewIcon name="arrow-right" />
              <span>Keep</span>
            </button>
          ) : null}
          <button
            className="review-button review-button--primary"
            type="submit"
            title={saveLabel}
            disabled={!canSave || submitting}
            aria-disabled={!canSave || submitting}
            data-submitting={submitting ? 'true' : undefined}
          >
            {submitting ? <ReviewIcon name="loading" /> : null}
            <span>{saveLabel}</span>
          </button>
        </div>
      </div>
    </form>
  );
}
