import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';

import { CopyLinkControl } from './CopyLinkControl.js';
import type { CopyLinkActionData } from './copy-link-model.js';
import { compositeFocusIndex, enabledMenuItems } from './menu-focus.js';
import { ReviewIcon, type ReviewIconName } from './ReviewIcon.js';

export const ROW_ACTION_CONTAINER_NAME = 'row-actions';
export const ROW_ACTION_DIRECT_BREAKPOINT_PX = 272;

interface RowActionBase {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly focusToken?: string;
}

export interface RowCommandAction extends RowActionBase {
  readonly kind: 'command';
  readonly icon: ReviewIconName;
  readonly onInvoke: () => void;
}

export interface RowCopyLinkAction extends RowActionBase {
  readonly kind: 'copy-link';
  readonly copyLink: CopyLinkActionData;
}

export type RowAction = RowCommandAction | RowCopyLinkAction;

export interface RowActionGroupProps {
  readonly actions: readonly RowAction[];
  readonly rowLabel: string;
}

function assignFocusToken(ref: Ref<HTMLButtonElement> | undefined, token: string | undefined) {
  return (node: HTMLButtonElement | null) => {
    if (node && token) node.dataset.workspaceFocusToken = token;
    if (typeof ref === 'function') ref(node);
    else if (ref != null) ref.current = node;
  };
}

function DirectAction({ action }: { readonly action: RowAction }) {
  if (action.kind === 'copy-link') {
    return (
      <CopyLinkControl
        {...action.copyLink}
        ariaLabel={action.label}
        title={action.title}
        variant="row"
        triggerRef={assignFocusToken(undefined, action.focusToken)}
      />
    );
  }
  return (
    <button
      type="button"
      className="row-action-group__action"
      data-row-action={action.id}
      data-workspace-focus-token={action.focusToken}
      aria-label={action.label}
      title={action.title}
      onClick={action.onInvoke}
    >
      <ReviewIcon name={action.icon} size={15} />
    </button>
  );
}

export function RowActionGroup({ actions, rowLabel }: RowActionGroupProps) {
  const [open, setOpen] = useState(false);
  const generatedId = useId().replaceAll(':', '');
  const menuId = `row-actions-menu-${generatedId}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  if (actions.length === 0) return null;

  const closeAndRestore = () => {
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus({ preventScroll: true }));
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestore();
      return;
    }
    const items = enabledMenuItems(event.currentTarget);
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (currentIndex < 0) return;
    const nextIndex = compositeFocusIndex(currentIndex, items.length, event.key);
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus({ preventScroll: true });
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className="row-action-group"
      data-row-action-count={actions.length}
      data-row-actions-open={open ? 'true' : undefined}
      onBlur={onBlur}
    >
      <div className="row-action-group__direct" aria-label={`Actions for ${rowLabel}`}>
        {actions.map((action) => <DirectAction key={action.id} action={action} />)}
      </div>
      <div className="row-action-group__secondary">
        <button
          ref={triggerRef}
          type="button"
          className="row-action-group__trigger"
          data-row-secondary-actions
          aria-label={`Secondary actions for ${rowLabel}`}
          title={`More actions for ${rowLabel}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen((current) => !current)}
        >
          <ReviewIcon name="more-horizontal" />
        </button>
        {open ? (
          <div
            id={menuId}
            className="row-action-group__menu"
            role="menu"
            aria-label={`Actions for ${rowLabel}`}
            onKeyDown={onMenuKeyDown}
          >
            {actions.map((action) => action.kind === 'copy-link' ? (
              <CopyLinkControl
                key={action.id}
                {...action.copyLink}
                ariaLabel={action.label}
                title={action.title}
                variant="row"
                presentation="labeled"
                buttonRole="menuitem"
                feedbackPlacement="inline"
                triggerRef={assignFocusToken(undefined, action.focusToken)}
              />
            ) : (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                data-row-action={action.id}
                data-workspace-focus-token={action.focusToken}
                title={action.title}
                onClick={() => {
                  action.onInvoke();
                  closeAndRestore();
                }}
              >
                <ReviewIcon name={action.icon} size={15} />
                <span>{action.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
