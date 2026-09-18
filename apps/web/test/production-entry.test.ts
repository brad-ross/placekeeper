import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  RuntimeLoadingWorkspace,
  runtimeGenerationRefreshStatus,
  parseVscodePresentationState,
  terminalRecoveryDocumentIdentity,
  terminalRecoveryLocationFragment,
} from '../src/production-entry.js';

describe('runtime generation refresh presentation', () => {
  it('keeps initial preparation failure separate from later rebuild failure', () => {
    const initialFailure = renderToStaticMarkup(createElement(RuntimeLoadingWorkspace, {
      refreshStatus: 'failed',
    }));

    expect(initialFailure.match(/role="alert"/gu)).toHaveLength(1);
    expect(initialFailure).toContain('This review could not be prepared.');
    expect(initialFailure).not.toContain('rebuilt PDF');
    expect(initialFailure).not.toContain('last successful PDF');
    expect(runtimeGenerationRefreshStatus(false, 'failed')).toBe('idle');
    expect(runtimeGenerationRefreshStatus(true, 'failed')).toBe('failed');
    expect(runtimeGenerationRefreshStatus(true, 'reconciling')).toBe('reconciling');
  });
});

describe('terminal readable-view recovery', () => {
  it('preserves canonical page, item, and durable destination fragments', () => {
    expect(terminalRecoveryLocationFragment('#v=1&page=3')).toBe('v=1&page=3');
    expect(terminalRecoveryLocationFragment(
      '#v=1&page=4&item=00000000-0000-4000-8000-000000000044',
    )).toBe('v=1&page=4&item=00000000-0000-4000-8000-000000000044');
    expect(terminalRecoveryLocationFragment(
      '#v=2&page=7&mode=xyz&params=12,640,1.25',
    )).toBe('v=2&page=7&mode=xyz&params=12,640,1.25');
  });

  it('converges malformed stale-route fragments to canonical page 1', () => {
    expect(terminalRecoveryLocationFragment('#unsafe')).toBe('v=1&page=1');
  });

  it('derives only the human-readable filename needed by the recovery heading', () => {
    expect(terminalRecoveryDocumentIdentity(
      'placekeeper:///Users/brad/Papers/Current%20Draft.pdf',
    )).toEqual({
      filename: 'Current Draft.pdf',
    });
    expect(terminalRecoveryDocumentIdentity(
      'placekeeper:///Root%20Paper.pdf',
    )).toEqual({
      filename: 'Root Paper.pdf',
    });
  });
});

describe('VS Code presentation restoration', () => {
  it('restores only bounded view-local page and zoom state', () => {
    expect(parseVscodePresentationState({
      panelKey: 'opaque-panel-key',
      pageIndex: 4,
      zoom: 1.25,
      credential: 'must-not-survive',
    })).toEqual({ pageIndex: 4, zoom: 1.25 });
    expect(parseVscodePresentationState({ pageIndex: -1, zoom: 1.25 })).toBeUndefined();
    expect(parseVscodePresentationState({ pageIndex: 1, zoom: 100 })).toBeUndefined();
  });
});
