import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';

import type { PdfTargetVisibility } from '../pdf/viewer-navigation.js';
import type { AuthoringSourceContext } from './authoring-session.js';
import { ReviewIcon } from './ReviewIcon.js';

export interface CommentComposerAnchorNavigation {
  readonly visibility: PdfTargetVisibility;
  readonly pending: boolean;
  readonly onReturn: () => void;
}

export interface CommentComposerProps {
  title: string;
  sourceContext: AuthoringSourceContext;
  initialValue?: string;
  optional?: boolean;
  allowWhitespace?: boolean;
  fieldLabel?: string;
  saveLabel?: string;
  anchorNavigation?: CommentComposerAnchorNavigation | undefined;
  editorRef?: RefObject<HTMLTextAreaElement | null>;
  surfaceRef?: (element: HTMLElement | null) => void;
  onReadDocument?(): void;
  onSave(value: string): void | Promise<void>;
  onSkip?: (() => void | Promise<void>) | undefined;
  onDismiss(): void | Promise<void>;
}

interface ContextPart {
  readonly text: string;
  readonly truncated: boolean;
}

const SELECTION_SIDE_LIMIT = 72;
const SELECTION_QUOTE_LIMIT = 120;
const CARET_SIDE_LIMIT = 110;
const PAGE_CONTEXT_LIMIT = 220;

function leadingContext(text: string, limit: number): ContextPart {
  const value: string[] = [];
  for (const character of text) {
    if (value.length === limit) {
      return {
        text: `${value.slice(0, Math.max(0, limit - 1)).join('')}…`,
        truncated: true,
      };
    }
    value.push(character);
  }
  return { text, truncated: false };
}

function trailingContext(text: string, limit: number): ContextPart {
  const value = new Array<string>(limit);
  let count = 0;
  for (const character of text) {
    value[count % limit] = character;
    count += 1;
  }
  if (count <= limit) return { text, truncated: false };
  const kept = Math.max(0, limit - 1);
  const start = (count - kept) % limit;
  const suffix = Array.from(
    { length: kept },
    (_, index) => value[(start + index) % limit],
  ).join('');
  return { text: `…${suffix}`, truncated: true };
}

function sourceKindLabel(context: AuthoringSourceContext): string {
  if (context.kind === 'selection') return 'Selected text';
  if (context.kind === 'caret') return 'Insertion point';
  if (context.kind === 'page') return 'Page context';
  return context.anchorLabel;
}

function SourceContext({ context }: { readonly context: AuthoringSourceContext }) {
  const [expanded, setExpanded] = useState(false);
  const { selectionCompact, caretCompact, pageCompact } = useMemo(() => ({
    selectionCompact: context.kind === 'selection' ? {
      prefix: trailingContext(context.prefix, SELECTION_SIDE_LIMIT),
      quote: leadingContext(context.quote, SELECTION_QUOTE_LIMIT),
      suffix: leadingContext(context.suffix, SELECTION_SIDE_LIMIT),
    } : null,
    caretCompact: context.kind === 'caret' ? {
      left: trailingContext(context.leftContext, CARET_SIDE_LIMIT),
      right: leadingContext(context.rightContext, CARET_SIDE_LIMIT),
    } : null,
    pageCompact: context.kind === 'page'
      ? leadingContext(context.nearbyText, PAGE_CONTEXT_LIMIT)
      : null,
  }), [context]);
  const truncated = selectionCompact !== null
    ? selectionCompact.prefix.truncated
      || selectionCompact.quote.truncated
      || selectionCompact.suffix.truncated
    : caretCompact !== null
      ? caretCompact.left.truncated || caretCompact.right.truncated
      : pageCompact?.truncated ?? false;

  const pageLabel = `Page ${context.pageNumber}`;
  const prose = (() => {
    if (context.kind === 'selection' && selectionCompact !== null) {
      return <p className="comment-composer__source-prose">
        <span>{expanded ? context.prefix : selectionCompact.prefix.text}</span>
        <mark>{expanded ? context.quote : selectionCompact.quote.text}</mark>
        <span>{expanded ? context.suffix : selectionCompact.suffix.text}</span>
      </p>;
    }
    if (context.kind === 'caret' && caretCompact !== null) {
      return <p className="comment-composer__source-prose comment-composer__source-prose--caret">
        <span>{expanded ? context.leftContext : caretCompact.left.text}</span>
        <span
          className="comment-composer__source-caret"
          data-context-caret
          role="img"
          aria-label="Original insertion point"
        />
        <span>{expanded ? context.rightContext : caretCompact.right.text}</span>
      </p>;
    }
    if (context.kind === 'page' && pageCompact !== null) {
      return <p className="comment-composer__source-prose">
        {expanded ? context.nearbyText : pageCompact.text}
      </p>;
    }
    return <p className="comment-composer__source-unavailable">
      <strong>{context.kind === 'anchor' ? context.anchorLabel : 'Anchor'}</strong>
      <span>Text context unavailable</span>
    </p>;
  })();

  return (
    <section
      className="comment-composer__source"
      data-source-context={context.kind}
      data-context-expanded={expanded ? 'true' : 'false'}
      aria-label="Source context"
    >
      <header className="comment-composer__source-header">
        <span>{sourceKindLabel(context)}</span>
        <strong>{pageLabel}</strong>
      </header>
      <div className="comment-composer__source-viewport">{prose}</div>
      {truncated ? (
        <button
          className="comment-composer__context-disclosure"
          type="button"
          title={expanded ? 'Show compact source context' : 'Show full source context'}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >{expanded ? 'Show Less Context' : 'Show Full Context'}</button>
      ) : null}
    </section>
  );
}

function AnchorReturn({ navigation }: {
  readonly navigation?: CommentComposerAnchorNavigation | undefined;
}) {
  const visibility = navigation?.visibility ?? 'unavailable';
  const state = navigation?.pending === true ? 'pending' : visibility;
  if (state === 'visible') {
    return <p className="comment-composer__anchor-status" data-return-state="visible">
      <span className="comment-composer__anchor-dot" aria-hidden="true" />
      Anchor in view
    </p>;
  }
  const label = state === 'pending'
    ? 'Returning…'
    : state === 'outside'
      ? 'Return to Anchor'
      : 'Anchor unavailable';
  return (
    <button
      className="comment-composer__return"
      type="button"
      title={label}
      data-return-state={state}
      disabled={state !== 'outside'}
      onClick={() => navigation?.onReturn()}
    >
      <ReviewIcon name={state === 'pending' ? 'loading' : 'locate'} />
      <span>{label}</span>
    </button>
  );
}

export function CommentComposer({
  title,
  sourceContext,
  initialValue = '',
  optional = false,
  allowWhitespace = false,
  fieldLabel = optional ? 'Comment (optional)' : 'Comment',
  saveLabel = 'Save',
  anchorNavigation,
  editorRef,
  surfaceRef,
  onReadDocument,
  onSave,
  onSkip,
  onDismiss,
}: CommentComposerProps) {
  const titleId = useId();
  const ownInputRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = editorRef ?? ownInputRef;
  const [value, setValue] = useState(initialValue);
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

  const submit = () => {
    if (canSave) void onSave(value);
  };

  return (
    <form
      ref={surfaceRef}
      role="region"
      aria-labelledby={titleId}
      className="comment-composer compact-editorial-modal"
      data-comment-composer
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <header className="comment-composer__header compact-editorial-modal__header">
        <h2 id={titleId}>{title}</h2>
        {onReadDocument === undefined ? null : (
          <button
            className="comment-composer__read review-button review-button--secondary"
            type="button"
            title="Read Document"
            onClick={onReadDocument}
          >
            <ReviewIcon name="main" />
            <span>Read Document</span>
          </button>
        )}
      </header>
      <div className="comment-composer__body compact-editorial-modal__body">
        <div className="comment-composer__context-row">
          <SourceContext context={sourceContext} />
          <AnchorReturn navigation={anchorNavigation} />
        </div>
        <label className="comment-composer__field">
          <span className="sr-only">{fieldLabel}</span>
          <textarea
            className="comment-composer__input"
            ref={inputRef}
            title={fieldLabel}
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSave) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </label>
      </div>
      <footer className="comment-composer__actions compact-editorial-modal__footer">
        <button
          className="review-button review-button--secondary"
          type="button"
          title="Cancel"
          onClick={() => void onDismiss()}
        >
          <ReviewIcon name="close" />
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
          disabled={!canSave}
        >
          <ReviewIcon name="check" />
          <span>{saveLabel}</span>
        </button>
      </footer>
    </form>
  );
}
