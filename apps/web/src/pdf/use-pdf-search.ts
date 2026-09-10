import { useRef, useState } from 'react';
import type { PdfDocumentObject, PdfEngine } from '@embedpdf/models';
import { createEnginePdfSearchPageReader, createPdfSearchController, type PdfSearchController } from './pdf-search-controller.js';
import { initialPdfSearchState } from './pdf-search-model.js';

/** Search owns demand and indexing. The application invokes reset/dispose in its
 * ordered document-replacement and viewer teardown transactions. */
export function usePdfSearch() {
  const searchControllerRef = useRef<PdfSearchController | null>(null);
  const searchDocumentRef = useRef<PdfDocumentObject | null>(null);
  const pendingSearchQueryRef = useRef('');
  const submittedSearchQueryRef = useRef('');
  const searchSubmitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRequestedRef = useRef(false);
  const [searchState, setSearchState] = useState(() => initialPdfSearchState());
  const submitSearchQuery = (query: string, immediate = false) => {
    pendingSearchQueryRef.current = query;
    const search = searchControllerRef.current;
    setSearchState((current) => ({
      ...current,
      query,
      status: query.trim().length > 0 ? 'indexing' : 'idle',
      groups: [],
      selectedResultId: null,
      alternatives: [],
      message: '',
    }));
    if (!search) return;
    if (searchSubmitTimerRef.current !== null) clearTimeout(searchSubmitTimerRef.current);
    const run = () => {
      searchSubmitTimerRef.current = null;
      submittedSearchQueryRef.current = query;
      void search.search(query);
    };
    if (immediate) run();
    else searchSubmitTimerRef.current = setTimeout(run, 180);
  };
  const initialize = (engine: PdfEngine, document: PdfDocumentObject, documentGeneration: number,
    onDocumentReady: () => void, onSearchDocumentReady: () => void) => {
    if (searchDocumentRef.current === document && searchControllerRef.current) return;
    // Preserve readiness publication before replacing the search controller.
    onDocumentReady();
    searchControllerRef.current?.dispose();
    searchDocumentRef.current = document;
    onSearchDocumentReady();
    const search = createPdfSearchController({
      documentGeneration,
      reader: createEnginePdfSearchPageReader(engine, document),
    });
    searchControllerRef.current = search;
    setSearchState(search.getState());
    search.subscribe((next) => {
      const pendingQuery = pendingSearchQueryRef.current;
      if (pendingQuery === submittedSearchQueryRef.current) {
        setSearchState(next);
        return;
      }
      setSearchState({
        ...next,
        query: pendingQuery,
        status: pendingQuery.trim().length > 0 ? 'indexing' : 'idle',
        groups: [],
        selectedResultId: null,
        alternatives: [],
        message: '',
      });
    });
    const pendingQuery = pendingSearchQueryRef.current;
    if (pendingQuery.trim().length > 0) {
      submittedSearchQueryRef.current = pendingQuery;
      void search.search(pendingQuery);
    }
    else if (searchRequestedRef.current) void search.prepare();
  };
  const reset = () => {
    searchControllerRef.current?.dispose();
    searchControllerRef.current = null;
    searchDocumentRef.current = null;
    if (searchSubmitTimerRef.current !== null) clearTimeout(searchSubmitTimerRef.current);
    searchSubmitTimerRef.current = null;
    pendingSearchQueryRef.current = '';
    submittedSearchQueryRef.current = '';
    searchRequestedRef.current = false;
    setSearchState(initialPdfSearchState());
  };
  const dispose = () => {
    if (searchSubmitTimerRef.current !== null) clearTimeout(searchSubmitTimerRef.current);
    searchControllerRef.current?.dispose();
  };
  return {
    searchState, submitSearchQuery, initialize, reset, dispose,
    getPageCount: () => searchDocumentRef.current?.pages.length ?? 0,
    isCurrentDocument: (document: PdfDocumentObject) => searchDocumentRef.current === document,
    selectResult: (id: string) => searchControllerRef.current?.selectResult(id),
    prepare: () => {
      searchRequestedRef.current = true;
      void searchControllerRef.current?.prepare();
    },
  };
}
