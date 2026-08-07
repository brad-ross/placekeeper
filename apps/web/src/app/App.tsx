import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PluginRegistry } from '@embedpdf/core';
import { DocumentManagerPlugin } from '@embedpdf/plugin-document-manager';
import { InteractionManagerPlugin } from '@embedpdf/plugin-interaction-manager';
import { ScrollPlugin } from '@embedpdf/plugin-scroll';
import { SelectionPlugin } from '@embedpdf/plugin-selection';

import {
  inventoryDocumentAnnotations,
  type ExistingAnnotation,
} from '../pdf/existing-annotations.js';
import { createLocalPdfiumViewer, type ViewerAssetUrls } from '../pdf/embedpdf-viewer.js';
import { PdfWorkspace } from '../pdf/PdfWorkspace.js';
import type { SelectionAnchorResult } from '../pdf/selection-anchor.js';
import { assessPageTextReliability } from '../pdf/text-reliability.js';
import {
  captureViewerSelection,
  createEngineAnchorPageReader,
} from '../pdf/viewer-selection-adapter.js';
import { ProofreadMode } from '../review/ProofreadMode.js';
import type { ReviewAnnotation } from '../../../../packages/core/src/pdf-writer.js';

export interface AppProps {
  assets: ViewerAssetUrls;
  existingAnnotations?: readonly ExistingAnnotation[];
  pageSemanticReliable?: boolean;
  selectionSemanticReliable?: boolean;
  onViewerInitialized?: (registry: PluginRegistry) => Promise<void>;
  onSelectionAnchor?: (result: SelectionAnchorResult) => void;
  documentTitle?: string;
  toolError?: string | null;
  /** Production composes the viewer inside the canonical ReviewShell toolbar. */
  hideProofreadControls?: boolean;
  ownedAnnotations?: readonly ReviewAnnotation[];
  onPagePoint?: (point: { readonly pageIndex: number; readonly x: number; readonly y: number }) => void;
}

export function App({
  assets,
  existingAnnotations = [],
  pageSemanticReliable,
  selectionSemanticReliable,
  onViewerInitialized,
  onSelectionAnchor,
  documentTitle = 'Local PDF',
  toolError = null,
  hideProofreadControls = false,
  ownedAnnotations = [],
  onPagePoint,
}: AppProps) {
  const [proofreadActive, setProofreadActive] = useState(false);
  const [sourceAnnotations, setSourceAnnotations] = useState<readonly ExistingAnnotation[]>([]);
  const [detectedPageReliable, setDetectedPageReliable] = useState(true);
  const [detectedSelectionReliable, setDetectedSelectionReliable] = useState(true);
  const subscriptions = useRef<Array<() => void>>([]);
  const pageReadGeneration = useRef(0);
  const selectionReadGeneration = useRef(0);
  const viewer = useMemo(() => createLocalPdfiumViewer(assets), [assets]);

  const clearSubscriptions = useCallback(() => {
    for (const unsubscribe of subscriptions.current.splice(0)) unsubscribe();
  }, []);
  useEffect(() => clearSubscriptions, [clearSubscriptions]);

  const initializeViewer = useCallback(async (registry: PluginRegistry) => {
    clearSubscriptions();
    const interaction = registry
      .getPlugin<InteractionManagerPlugin>(InteractionManagerPlugin.id)
      ?.provides();
    const selection = registry.getPlugin<SelectionPlugin>(SelectionPlugin.id)?.provides();
    if (interaction && selection) {
      selection.enableForMode(interaction.getDefaultMode(), {
        enableSelection: true,
        showSelectionRects: true,
        enableMarquee: false,
      });
    }

    const readPage = async (documentId: string, pageIndex: number) => {
      const generation = ++pageReadGeneration.current;
      const document = registry.getStore().getState().core.documents[documentId]?.document;
      if (!document) return;
      const reader = createEngineAnchorPageReader(registry.getEngine(), document);
      const page = await reader.read(pageIndex);
      if (generation === pageReadGeneration.current) {
        setDetectedPageReliable(assessPageTextReliability(page).reliable);
        setDetectedSelectionReliable(true);
      }
    };
    const loadDocument = async (documentId: string) => {
      const document = registry.getStore().getState().core.documents[documentId]?.document;
      if (!document) return;
      if (interaction && onPagePoint) {
        for (const page of document.pages) {
          subscriptions.current.push(interaction.registerAlways({
            scope: { type: 'page', documentId, pageIndex: page.index },
            handlers: {
              onClick: (position) => onPagePoint({
                pageIndex: page.index,
                // PagePointerProvider returns natural, unscaled, crop-relative
                // coordinates. Canonical review geometry is PDF user space.
                x: position.x + (page.boxes?.crop.left ?? 0),
                y: position.y + (page.boxes?.crop.top ?? 0),
              }),
            },
          }));
        }
      }
      await Promise.all([
        readPage(documentId, 0),
        inventoryDocumentAnnotations(registry.getEngine(), document).then(
          setSourceAnnotations,
        ),
      ]);
    };

    const documentManager = registry
      .getPlugin<DocumentManagerPlugin>(DocumentManagerPlugin.id)
      ?.provides();
    if (documentManager) {
      subscriptions.current.push(
        documentManager.onDocumentOpened(({ document }) => {
          if (document) void loadDocument(document.id);
        }),
      );
    }

    const scroll = registry.getPlugin<ScrollPlugin>(ScrollPlugin.id)?.provides();
    if (scroll) {
      subscriptions.current.push(
        scroll.onPageChange(({ documentId, pageNumber }) => {
          void readPage(documentId, pageNumber - 1);
        }),
      );
    }

    if (selection) {
      const captureSelection = async (documentId: string) => {
        const generation = ++selectionReadGeneration.current;
        const document = registry.getStore().getState().core.documents[documentId]?.document;
        if (!document) return;
        const result = await captureViewerSelection({
          documentId,
          selection,
          pages: createEngineAnchorPageReader(registry.getEngine(), document),
        });
        if (generation === selectionReadGeneration.current) {
          setDetectedSelectionReliable(result.ok);
          onSelectionAnchor?.(result);
        }
      };
      subscriptions.current.push(
        selection.onSelectionChange(({ documentId, selection: selectedRange }) => {
          if (selectedRange === null) {
            selectionReadGeneration.current += 1;
            setDetectedSelectionReliable(true);
          } else {
            void captureSelection(documentId);
          }
        }),
        selection.onEndSelection(({ documentId }) => {
          void captureSelection(documentId);
        }),
      );
    }

    const activeDocumentId = registry.getStore().getState().core.activeDocumentId;
    if (activeDocumentId) await loadDocument(activeDocumentId);
    await onViewerInitialized?.(registry);
  }, [clearSubscriptions, onPagePoint, onSelectionAnchor, onViewerInitialized]);

  const effectivePageReliability = pageSemanticReliable ?? detectedPageReliable;
  const effectiveSelectionReliability =
    selectionSemanticReliable ?? detectedSelectionReliable;

  const content = (
    <main>
      <h1>Local PDF Proofreader</h1>
      <p data-document-title>{documentTitle}</p>
      {toolError ? <p role="alert">{toolError}</p> : null}
      {hideProofreadControls ? (
        <PdfWorkspace
          engine={viewer.engine}
          plugins={viewer.plugins}
          documentLabel={documentTitle}
          onInitialized={initializeViewer}
          ownedAnnotations={ownedAnnotations}
        />
      ) : (
        <ProofreadMode
          active={proofreadActive}
          onActiveChange={setProofreadActive}
          pageSemanticReliable={effectivePageReliability}
          selectionSemanticReliable={effectiveSelectionReliability}
        >
          <PdfWorkspace
            engine={viewer.engine}
            plugins={viewer.plugins}
            documentLabel={documentTitle}
            onInitialized={initializeViewer}
            ownedAnnotations={ownedAnnotations}
          />
        </ProofreadMode>
      )}
      <aside aria-label="Existing annotations">
        <h2>Existing annotations</h2>
        {existingAnnotations.length + sourceAnnotations.length === 0 ? <p>None</p> : null}
        <ol>
          {[...sourceAnnotations, ...existingAnnotations].map((annotation, index) => (
            <li key={`${annotation.pageIndex}:${annotation.id}:${index}`}>
              <span>{annotation.subtype}</span>{' '}
              <span>{`Page ${annotation.pageIndex + 1}`}</span>{' '}
              <span>{annotation.contents}</span>
            </li>
          ))}
        </ol>
      </aside>
    </main>
  );
  return content;
}
