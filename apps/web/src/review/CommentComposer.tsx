import {
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
  saveDisabled?: boolean;
  persistencePending?: boolean;
  anchorNavigation?: CommentComposerAnchorNavigation | undefined;
  editorRef?: RefObject<HTMLTextAreaElement | null>;
  surfaceRef?: (element: HTMLElement | null) => void;
  placement?: CommentComposerPlacement;
  deferUntilPlacement?: boolean;
  passageExposure?: {
    readonly exposed: boolean;
    readonly onExpose: () => void;
    readonly onResume: () => void;
  };
  onValueChange?(value: string): void;
  onSave(value: string): void | Promise<void>;
  onDismiss(): void | Promise<void>;
}

function AnchorReturn({ navigation, onActivate }: {
  readonly navigation?: CommentComposerAnchorNavigation | undefined;
  readonly onActivate?: () => void;
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
      onClick={() => {
        navigation?.onReturn();
        onActivate?.();
      }}
    >
      <ReviewIcon name={state === 'pending' ? 'loading' : 'locate'} size={16} />
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

export function focusCommentComposerEditor(
  editor: Pick<HTMLTextAreaElement, 'focus' | 'setSelectionRange' | 'value'>,
): void {
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(editor.value.length, editor.value.length);
}

export function CommentComposer({
  title,
  initialValue = '',
  optional = false,
  allowWhitespace = false,
  fieldLabel = optional ? 'Comment (optional)' : 'Comment',
  saveLabel = 'Save',
  saveDisabled = false,
  persistencePending = false,
  anchorNavigation,
  editorRef,
  surfaceRef,
  placement,
  deferUntilPlacement = false,
  passageExposure,
  onValueChange,
  onSave,
  onDismiss,
}: CommentComposerProps) {
  const titleId = useId();
  const ownInputRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = editorRef ?? ownInputRef;
  const [value, setValue] = useState(initialValue);
  const [submitting, setSubmitting] = useState(false);
  const composingRef = useRef(false);
  const passageSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const busy = submitting || persistencePending;
  const canSave = !saveDisabled && !persistencePending
    && (optional || (allowWhitespace ? value.length > 0 : value.trim().length > 0));
  const placementPending = deferUntilPlacement && placement === undefined;

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input !== null) focusCommentComposerEditor(input);
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
  const exposePassage = () => {
    const input = inputRef.current;
    passageSelectionRef.current = input === null
      ? null
      : { start: input.selectionStart, end: input.selectionEnd };
    passageExposure?.onExpose();
  };
  const resumeEditing = () => {
    passageExposure?.onResume();
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (input === null) return;
      input.focus({ preventScroll: true });
      const selection = passageSelectionRef.current;
      if (selection !== null) input.setSelectionRange(selection.start, selection.end);
    });
  };
  const passageExposed = passageExposure?.exposed === true;

  return (
    <form
      ref={surfaceRef}
      role="region"
      aria-labelledby={titleId}
      className="comment-composer compact-editorial-modal"
      data-comment-composer
      data-composer-placement={placementPending ? 'pending' : placement?.kind}
      data-passage-exposed={passageExposed ? 'true' : undefined}
      style={placementPending ? { opacity: 0, pointerEvents: 'none' } : placement?.style}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <header className="comment-composer__header compact-editorial-modal__header">
        <h2 id={titleId}>
          <ReviewIcon name={composerIcon(title)} size={16} />
          <span>{title}{anchorNavigation?.visibility === 'outside' && anchorNavigation.pageNumber !== undefined
            ? <span className="comment-composer__page-cue"> · {anchorNavigation.pageNumber}</span>
            : null}</span>
        </h2>
        {passageExposed ? (
          <button
            type="button"
            className="comment-composer__resume review-button review-button--secondary"
            aria-label="Resume editing"
            title="Resume editing"
            onClick={resumeEditing}
          >
            <ReviewIcon name="edit" size={16} />
            <span>Resume editing</span>
          </button>
        ) : anchorNavigation?.visibility === 'outside' || anchorNavigation?.pending
          ? <AnchorReturn
              navigation={anchorNavigation}
              {...(passageExposure === undefined ? {} : { onActivate: exposePassage })}
            />
          : null}
      </header>
      <div
        className="comment-composer__body compact-editorial-modal__body"
        hidden={passageExposed}
        inert={passageExposed}
        aria-hidden={passageExposed || undefined}
      >
        <label className="comment-composer__field">
          <span className="sr-only">{fieldLabel}</span>
          <textarea
            className="comment-composer__input"
            ref={inputRef}
            title={fieldLabel}
            placeholder="Add a comment…"
            value={value}
            readOnly={persistencePending}
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
        {busy ? (
          <span className="sr-only" role="status">
            {persistencePending ? 'Saving annotation to PDF.' : 'Saving annotation.'}
          </span>
        ) : null}
        <div className="comment-composer__actions">
          <button
            className="review-button review-button--secondary"
            type="button"
            title="Cancel"
            onClick={() => void onDismiss()}
          >
            <span>Cancel</span>
          </button>
          <button
            className="review-button review-button--primary"
            type="submit"
            title={saveLabel}
            disabled={!canSave || busy}
            aria-disabled={!canSave || busy}
            aria-busy={busy ? 'true' : undefined}
            data-submitting={busy ? 'true' : undefined}
          >
            {busy ? <ReviewIcon name="loading" /> : null}
            <span>{saveLabel}</span>
          </button>
        </div>
      </div>
    </form>
  );
}
