import { describe, expect, it, vi } from 'vitest';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  buildPlacekeeperCopyLink,
  CopyLinkControl,
  createCopyLinkCommand,
  type CopyLinkStatus,
} from '../src/review/CopyLinkControl.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('Copy Link', () => {
  it('uses the app-native chain-link glyph with the shared icon defaults', () => {
    const markup = renderToStaticMarkup(createElement(CopyLinkControl, {
      getLink: () => 'placekeeper:///tmp/Paper.pdf#v=1&page=4',
      writeText: async () => undefined,
    }));

    expect(markup).toContain('lucide-link');
    expect(markup).not.toContain('lucide-clipboard');
    expect(markup).toContain('width="16"');
    expect(markup).toContain('height="16"');
    expect(markup).toContain('stroke-width="1.875"');
  });

  it('adapts presentation and semantics without a transient native tooltip', () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const markup = renderToStaticMarkup(createElement(CopyLinkControl, {
      getLink: () => 'placekeeper:///tmp/Paper.pdf#v=2&page=4&view=xyz&x=12&y=24&zoom=1',
      writeText: async () => undefined,
      ariaLabel: 'Copy link to exact destination on page 4',
      title: 'Copy exact destination link',
      variant: 'row',
      presentation: 'labeled',
      buttonRole: 'menuitem',
      triggerRef,
      feedbackPlacement: 'inline',
    }));

    expect(markup).toContain('copy-link-control--row');
    expect(markup).toContain('copy-link-control--feedback-inline');
    expect(markup).toContain('role="presentation"');
    expect(markup).toContain('role="menuitem"');
    expect(markup).toContain('aria-label="Copy link to exact destination on page 4"');
    expect(markup).not.toContain('title="Copy exact destination link"');
    expect(markup).toContain('<span class="copy-link-control__label">Copy link to exact destination on page 4</span>');
  });

  it('disables copying while the surrounding navigation is unsettled', () => {
    const markup = renderToStaticMarkup(createElement(CopyLinkControl, {
      disabled: true,
      getLink: () => 'placekeeper:///tmp/Paper.pdf#v=1&page=4',
      writeText: async () => undefined,
      title: 'Save annotation before copying its link',
    }));

    expect(markup).toContain('disabled=""');
    expect(markup).toContain('title="Save annotation before copying its link"');
  });

  it('constructs only a safe encoded fragment from the validated app-link base', () => {
    expect(buildPlacekeeperCopyLink(
      'placekeeper:///Users/reader/Paper%20One.pdf',
      { kind: 'item', page: 12, itemId: '00000000-0000-4000-8000-000000000012' },
    )).toBe('placekeeper:///Users/reader/Paper%20One.pdf#v=1&page=12&item=00000000-0000-4000-8000-000000000012');
    expect(() => buildPlacekeeperCopyLink(
      'placekeeper:///Users/reader/Paper.pdf#credential=secret',
      { kind: 'page', page: 1 },
    )).toThrow();

    expect(buildPlacekeeperCopyLink(
      'http://127.0.0.1:43179/r/22222222-2222-4222-8222-222222222222/Users/reader/Paper%20One.pdf',
      { kind: 'page', page: 7 },
    )).toBe(
      'http://127.0.0.1:43179/r/22222222-2222-4222-8222-222222222222/Users/reader/Paper%20One.pdf#v=1&page=7',
    );
    expect(() => buildPlacekeeperCopyLink(
      'https://example.com/r/22222222-2222-4222-8222-222222222222/Users/reader/Paper.pdf',
      { kind: 'page', page: 1 },
    )).toThrow();
  });

  it('deduplicates a pending write and reports honest success', async () => {
    const write = deferred<void>();
    const writeText = vi.fn(() => write.promise);
    const states: CopyLinkStatus[] = [];
    const onCopySuccess = vi.fn();
    const command = createCopyLinkCommand({
      getLink: () => 'placekeeper:///tmp/Paper.pdf#v=1&page=4',
      writeText,
      onStatus: (status) => states.push(status),
      onCopySuccess,
    });

    const first = command.run();
    const duplicate = command.run();
    expect(writeText).toHaveBeenCalledOnce();
    expect(states.at(-1)).toEqual({ status: 'pending' });
    write.resolve();
    await Promise.all([first, duplicate]);
    expect(states.at(-1)).toEqual({ status: 'success' });
    expect(onCopySuccess).toHaveBeenCalledOnce();
  });

  it('keeps the generated address selectable after clipboard failure and retries', async () => {
    const writeText = vi.fn()
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValueOnce(undefined);
    const states: CopyLinkStatus[] = [];
    let link = 'placekeeper:///tmp/Paper.pdf#v=1&page=7';
    const command = createCopyLinkCommand({
      getLink: () => link,
      writeText,
      onStatus: (status) => states.push(status),
    });

    await command.run();
    expect(states.at(-1)).toEqual({ status: 'failure', link });
    const failedLink = link;
    link = 'placekeeper:///tmp/Paper.pdf#v=1&page=9';
    await command.run(failedLink);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenNthCalledWith(1, failedLink);
    expect(writeText).toHaveBeenNthCalledWith(2, failedLink);
    expect(states.at(-1)).toEqual({ status: 'success' });
  });
});
