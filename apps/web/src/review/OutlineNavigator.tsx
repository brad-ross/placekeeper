import type {
  PdfOutlineDiscovery,
  PdfOutlineItem,
} from '../pdf/pdf-outline.js';
import type { PdfDestinationCopyLink } from './copy-link-model.js';
import { RowActionGroup, type RowAction } from './RowActionGroup.js';
import { ReviewIcon } from './ReviewIcon.js';
import { ReviewTooltipButton } from './ReviewTooltipButton.js';

export interface OutlineNavigatorProps {
  readonly discovery: PdfOutlineDiscovery;
  readonly currentItemId: string | null;
  readonly onActivate: (item: PdfOutlineItem) => void;
  readonly onOpenReference: (item: PdfOutlineItem) => void;
  readonly expandedItemIds: ReadonlySet<string>;
  readonly onExpandedItemIdsChange: (expandedItemIds: ReadonlySet<string>) => void;
  readonly copyLinkForItem?: (item: PdfOutlineItem) => PdfDestinationCopyLink | undefined;
  readonly onFocusTokenChange?: (token: string) => void;
}

export function OutlineNavigator({
  discovery,
  currentItemId,
  onActivate,
  onOpenReference,
  expandedItemIds,
  onExpandedItemIdsChange,
  copyLinkForItem,
  onFocusTokenChange,
}: OutlineNavigatorProps) {
  if (discovery.status === 'loading') {
    return <div className="outline-navigator">
      <p className="workspace-empty outline-navigator__loading" data-outline-state="loading" role="status">
        <span>Outline is loading</span>
        <ReviewIcon name="loading" />
      </p>
    </div>;
  }
  if (discovery.status === 'loaded-empty') {
    return <p className="workspace-state" data-outline-state="empty">This PDF has no embedded outline.</p>;
  }
  if (discovery.status === 'unavailable') {
    return <p className="workspace-state" data-outline-state="unavailable">Outline unavailable.</p>;
  }

  // Resolve presentation only: collapsing a branch does not change the PDF location.
  const visibleCurrentItem = (items: readonly PdfOutlineItem[]): string | null => {
    for (const item of items) {
      if (item.id === currentItemId) return item.id;
      const child = visibleCurrentItem(item.children);
      if (child !== null) return expandedItemIds.has(item.id) ? child : item.id;
    }
    return null;
  };
  const highlightedItemId = visibleCurrentItem(discovery.items);

  const flat = discovery.items.every((item) => item.children.length === 0);
  const toggle = (id: string) => {
    const next = new Set(expandedItemIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onExpandedItemIdsChange(next);
  };
  const renderItems = (items: readonly PdfOutlineItem[]) => (
    <ul>
      {items.map((item) => {
        const hasChildren = item.children.length > 0;
        const isExpanded = hasChildren && expandedItemIds.has(item.id);
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
              data-current={highlightedItemId === item.id ? 'true' : undefined}
            >
              {hasChildren ? (
                <ReviewTooltipButton
                  label={`${isExpanded ? 'Collapse' : 'Expand'} ${item.label}`}
                  type="button"
                  className="outline-navigator__disclosure"
                  aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${item.label}`}
                  aria-expanded={isExpanded}
                  aria-controls={childrenId}
                  onClick={() => toggle(item.id)}
                >
                  <ReviewIcon name="chevron-right" />
                </ReviewTooltipButton>
              ) : flat ? null : <span className="outline-navigator__disclosure-spacer" aria-hidden="true" />}
              <button
                type="button"
                className="outline-navigator__destination"
                aria-label={destinationLabel}
                title={item.target === null ? `${destinationLabel} is unavailable` : `Go to ${destinationLabel}`}
                aria-current={highlightedItemId === item.id ? 'location' : undefined}
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
    <nav className="outline-navigator" data-flat={flat ? 'true' : undefined} aria-label="Document outline">
      {renderItems(discovery.items)}
    </nav>
  );
}
