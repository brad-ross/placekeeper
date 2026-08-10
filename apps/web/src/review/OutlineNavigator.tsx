import { useEffect, useRef, useState } from 'react';

import type {
  PdfOutlineDiscovery,
  PdfOutlineItem,
} from '../pdf/pdf-outline.js';
import { ReviewIcon } from './ReviewIcon.js';

export interface OutlineOrderPoint {
  readonly pageIndex: number;
  /** A monotonic, top-to-bottom offset in one agreed document coordinate system. */
  readonly offset: number;
}

function compareOrder(first: OutlineOrderPoint, second: OutlineOrderPoint): number {
  return first.pageIndex - second.pageIndex || first.offset - second.offset;
}

interface OrderedOutlineItem {
  readonly item: PdfOutlineItem;
  readonly depth: number;
  readonly documentIndex: number;
  readonly point: OutlineOrderPoint;
}

/**
 * Finds the last safely ordered bookmark at or before a settled main-view anchor.
 * The caller supplies coordinate conversion because raw PDF destinations do not
 * carry enough page geometry to compare their offsets safely with viewer anchors.
 */
export function findCurrentOutlineItem(
  items: readonly PdfOutlineItem[],
  anchor: OutlineOrderPoint,
  orderPointFor: (item: PdfOutlineItem) => OutlineOrderPoint | null,
): PdfOutlineItem | null {
  const ordered: OrderedOutlineItem[] = [];
  let documentIndex = 0;
  const visit = (nodes: readonly PdfOutlineItem[], depth: number): boolean => {
    for (const item of nodes) {
      const index = documentIndex++;
      if (item.target) {
        const point = orderPointFor(item);
        if (point === null || !Number.isSafeInteger(point.pageIndex)
          || point.pageIndex < 0 || !Number.isFinite(point.offset)) return false;
        ordered.push({ item, depth, documentIndex: index, point });
      }
      if (!visit(item.children, depth + 1)) return false;
    }
    return true;
  };
  if (!visit(items, 0)) return null;

  let current: OrderedOutlineItem | null = null;
  for (const candidate of ordered) {
    if (compareOrder(candidate.point, anchor) > 0) continue;
    if (current === null) {
      current = candidate;
      continue;
    }
    const relative = compareOrder(candidate.point, current.point);
    if (
      relative > 0
      || (
        relative === 0
        && candidate.depth > current.depth
      )
      || (
        relative === 0
        && candidate.depth === current.depth
        && candidate.documentIndex > current.documentIndex
      )
    ) current = candidate;
  }
  return current?.item ?? null;
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
  readonly onActivate: (item: PdfOutlineItem, control: HTMLButtonElement) => void;
  readonly onFocusTokenChange?: (token: string) => void;
}

export function OutlineNavigator({
  discovery,
  currentItemId,
  onActivate,
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
        return (
          <li key={item.id} data-outline-item={item.id}>
            <div className="outline-navigator__row">
              {hasChildren ? (
                <button
                  type="button"
                  className="outline-navigator__disclosure"
                  aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${item.label}`}
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
                aria-current={currentItemId === item.id ? 'location' : undefined}
                aria-disabled={item.target === null ? true : undefined}
                disabled={item.target === null}
                inert={item.target === null}
                onFocus={() => onFocusTokenChange?.(`outline:${item.id}`)}
                onClick={(event) => {
                  if (item.target) onActivate(item, event.currentTarget);
                }}
              >
                <span>{item.label}</span>
                {item.pageContext && item.label !== item.pageContext
                  ? <small>{item.pageContext}</small>
                  : null}
              </button>
            </div>
            {hasChildren ? (
              <div id={childrenId} hidden={!isExpanded} inert={!isExpanded}>
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
