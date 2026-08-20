import { useEffect, useRef, useState } from 'react';

import type {
  PdfOutlineDiscovery,
  PdfOutlineItem,
} from '../pdf/pdf-outline.js';
import type { CopyLinkControlProps } from './CopyLinkControl.js';
import { RowActionGroup, type RowAction } from './RowActionGroup.js';
import { ReviewIcon } from './ReviewIcon.js';

export interface OutlineCopyLink extends Pick<
  CopyLinkControlProps,
  'getLink' | 'writeText' | 'disabled'
> {
  readonly precision: 'exact' | 'page';
}

function branchIds(items: readonly PdfOutlineItem[]): string[] {
  return items.flatMap((item) => [
    ...(item.children.length > 0 ? [item.id] : []),
    ...branchIds(item.children),
  ]);
}

export interface OutlineNavigatorProps {
  readonly discovery: PdfOutlineDiscovery;
  readonly currentItemId: string | null;
  readonly onActivate: (item: PdfOutlineItem) => void;
  readonly onOpenReference: (item: PdfOutlineItem) => void;
  readonly copyLinkForItem?: (item: PdfOutlineItem) => OutlineCopyLink | undefined;
  readonly onFocusTokenChange?: (token: string) => void;
}

export function OutlineNavigator({
  discovery,
  currentItemId,
  onActivate,
  onOpenReference,
  copyLinkForItem,
  onFocusTokenChange,
}: OutlineNavigatorProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(
    discovery.status === 'loaded-tree' ? branchIds(discovery.items) : [],
  ));
  const expansionDocument = useRef<number | null>(
    discovery.status === 'loaded-tree' ? discovery.documentGeneration : null,
  );

  useEffect(() => {
    if (discovery.status !== 'loaded-tree') {
      if (expansionDocument.current !== discovery.documentGeneration) {
        expansionDocument.current = null;
        setExpanded(new Set());
      }
      return;
    }
    if (expansionDocument.current === discovery.documentGeneration) return;
    expansionDocument.current = discovery.documentGeneration;
    setExpanded(new Set(branchIds(discovery.items)));
  }, [discovery]);

  if (discovery.status === 'loading') {
    return <p className="workspace-state" data-outline-state="loading">Outline is loading…</p>;
  }
  if (discovery.status === 'loaded-empty') {
    return <p className="workspace-state" data-outline-state="empty">This PDF has no embedded outline.</p>;
  }
  if (discovery.status === 'unavailable') {
    return <p className="workspace-state" data-outline-state="unavailable">Outline unavailable.</p>;
  }

  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const renderItems = (items: readonly PdfOutlineItem[]) => (
    <ul>
      {items.map((item) => {
        const hasChildren = item.children.length > 0;
        const isExpanded = hasChildren && expanded.has(item.id);
        const childrenId = `outline-children-${item.id}`;
        const destinationLabel = item.pageContext && item.label !== item.pageContext
          ? `${item.label}, ${item.pageContext}`
          : item.label;
        const pageNumber = item.target && item.pageContext && item.label !== item.pageContext
          ? item.target.pageIndex + 1
          : null;
        const copyLink = copyLinkForItem?.(item);
        const actions: readonly RowAction[] = item.target === null ? [] : [
          {
            kind: 'command',
            id: 'open-reference',
            label: `Open ${destinationLabel} in References`,
            title: 'Open in References',
            icon: 'references',
            focusToken: `outline-reference:${item.id}`,
            onInvoke: () => onOpenReference(item),
          },
          ...(copyLink === undefined ? [] : [{
            kind: 'copy-link' as const,
            id: 'copy-link',
            label: copyLink.precision === 'exact'
              ? `Copy exact destination link for ${destinationLabel}`
              : `Copy page link for ${destinationLabel}`,
            title: copyLink.precision === 'exact'
              ? 'Copy exact destination link'
              : 'Copy page link',
            focusToken: `outline-copy-link:${item.id}`,
            copyLink,
          }]),
        ];
        return (
          <li key={item.id} data-outline-item={item.id}>
            <div
              className="outline-navigator__row"
              data-current={currentItemId === item.id ? 'true' : undefined}
            >
              {hasChildren ? (
                <button
                  type="button"
                  className="outline-navigator__disclosure"
                  aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${item.label}`}
                  title={`${isExpanded ? 'Collapse' : 'Expand'} ${item.label}`}
                  aria-expanded={isExpanded}
                  aria-controls={childrenId}
                  onClick={() => toggle(item.id)}
                >
                  <ReviewIcon name="chevron-right" />
                </button>
              ) : <span className="outline-navigator__disclosure-spacer" aria-hidden="true" />}
              <button
                type="button"
                className="outline-navigator__destination"
                aria-label={destinationLabel}
                title={item.target === null ? `${destinationLabel} is unavailable` : `Go to ${destinationLabel}`}
                aria-current={currentItemId === item.id ? 'location' : undefined}
                aria-disabled={item.target === null ? true : undefined}
                disabled={item.target === null}
                inert={item.target === null}
                onFocus={() => onFocusTokenChange?.(`outline:${item.id}`)}
                onClick={() => {
                  if (item.target) onActivate(item);
                }}
              >
                <span className="outline-navigator__summary">
                  <span className="outline-navigator__title">{item.label}</span>
                  {pageNumber === null
                    ? null
                    : (
                      <>
                        <span className="outline-navigator__separator" aria-hidden="true">·</span>
                        <small className="outline-navigator__page" aria-hidden="true">{pageNumber}</small>
                      </>
                    )}
                </span>
              </button>
              <RowActionGroup actions={actions} rowLabel={destinationLabel} />
            </div>
            {hasChildren ? (
              <div
                className="outline-navigator__children"
                id={childrenId}
                hidden={!isExpanded}
                inert={!isExpanded}
              >
                {renderItems(item.children)}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );

  return (
    <nav className="outline-navigator" aria-label="Document outline">
      {renderItems(discovery.items)}
    </nav>
  );
}
