import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { PdfOutlineDiscovery } from '../pdf/pdf-outline.js';
import {
  createOutlineExpansionState,
  outlineBranchIds,
  setOutlineExpandedItemIds,
  toggleOutlineExpansionState,
  type OutlineExpansionState,
} from './outline-expansion-state.js';
import { OutlineExpansionToggle } from './OutlineExpansionToggle.js';

interface OutlineExpansionControllerValue extends OutlineExpansionState {
  readonly branchCount: number;
  readonly setExpandedItemIds: (expandedItemIds: ReadonlySet<string>) => void;
  readonly toggle: () => void;
}

const OutlineExpansionContext = createContext<OutlineExpansionControllerValue | null>(null);

export interface OutlineExpansionProviderProps {
  readonly discovery: PdfOutlineDiscovery;
  readonly children: ReactNode;
}

export function OutlineExpansionProvider({
  discovery,
  children,
}: OutlineExpansionProviderProps) {
  const branchItemIds = useMemo<readonly string[]>(() => (
    discovery.status === 'loaded-tree' ? outlineBranchIds(discovery.items) : []
  ), [discovery]);
  const [expansion, setExpansion] = useState(() => (
    createOutlineExpansionState(branchItemIds)
  ));
  const expansionDocument = useRef<number | null>(
    discovery.status === 'loaded-tree' ? discovery.documentGeneration : null,
  );

  useEffect(() => {
    if (discovery.status !== 'loaded-tree') {
      if (expansionDocument.current !== discovery.documentGeneration) {
        expansionDocument.current = null;
        setExpansion(createOutlineExpansionState([]));
      }
      return;
    }
    if (expansionDocument.current === discovery.documentGeneration) return;
    expansionDocument.current = discovery.documentGeneration;
    setExpansion(createOutlineExpansionState(branchItemIds));
  }, [branchItemIds, discovery]);

  const value = useMemo<OutlineExpansionControllerValue>(() => ({
    ...expansion,
    branchCount: branchItemIds.length,
    setExpandedItemIds: (expandedItemIds) => {
      setExpansion((current) => setOutlineExpandedItemIds(current, expandedItemIds));
    },
    toggle: () => setExpansion(toggleOutlineExpansionState),
  }), [branchItemIds.length, expansion]);

  return (
    <OutlineExpansionContext value={value}>
      {children}
    </OutlineExpansionContext>
  );
}

export function useOutlineExpansionController(): OutlineExpansionControllerValue {
  const controller = useContext(OutlineExpansionContext);
  if (controller === null) throw new Error('Outline expansion controller is unavailable.');
  return controller;
}

export interface OutlineExpansionToggleSlotProps {
  readonly visible: boolean;
}

export function OutlineExpansionToggleSlot({ visible }: OutlineExpansionToggleSlotProps) {
  const controller = useOutlineExpansionController();
  if (!visible || controller.branchCount === 0) return null;
  const restorePending = controller.restoreItemIds !== null;
  return (
    <OutlineExpansionToggle
      restorePending={restorePending}
      disabled={!restorePending && controller.expandedItemIds.size === 0}
      onToggle={controller.toggle}
    />
  );
}
