import { createCodexHostRuntime } from "../src/host/codex-runtime.js";
import { describe, expect, it, vi } from 'vitest';
import { createCopyLinkCommand } from '../src/review/CopyLinkControl.js';

describe('native link copying', () => {
  it('resolves a host link only on demand and retains a selectable link after clipboard denial', async () => {
    const statuses: unknown[] = [];
    const getLink = vi.fn(async () => 'placekeeper:///Review.pdf#v=1&page=1');
    const writeText = vi.fn(async () => { throw new Error('denied'); });
    const command = createCopyLinkCommand({ getLink, writeText, onStatus: status => statuses.push(status) });
    expect(getLink).not.toHaveBeenCalled();
    await command.run();
    expect(writeText).toHaveBeenCalledWith('placekeeper:///Review.pdf#v=1&page=1');
    expect(statuses.at(-1)).toEqual({ status: 'failure', link: 'placekeeper:///Review.pdf#v=1&page=1' });
  });
});

it('keeps synchronous clipboard calls in the click gesture', async () => {
  const writeText = vi.fn(async () => {});
  const command = createCopyLinkCommand({ getLink: () => 'placekeeper:///Review.pdf#v=1&page=1', writeText, onStatus: () => {} });
  const pending = command.run();
  expect(writeText).toHaveBeenCalledOnce();
  await pending;
});
it('reports generation failure without a bogus fallback link and resets pending for retry', async () => {
  const statuses: unknown[] = [];
  const getLink = vi.fn().mockRejectedValueOnce(new Error('replaced')).mockResolvedValue('placekeeper:///Review.pdf#v=1&page=1');
  const writeText = vi.fn(async () => {});
  const command = createCopyLinkCommand({ getLink, writeText, onStatus: status => statuses.push(status) });
  const first = command.run();
  expect(command.run()).toBe(first);
  await first;
  expect(statuses.at(-1)).toEqual({ status: 'unavailable' });
  expect(writeText).not.toHaveBeenCalled();
  await command.run();
  expect(statuses.at(-1)).toEqual({ status: 'success' });
});

it('maps semantic native link requests without a document path or browser URL', async () => {
  const call = vi.fn(async () => ({ link: 'placekeeper:///Review.pdf#v=1&page=1' }));
  const runtime = createCodexHostRuntime({ runtimeId: 'runtime_actions_1234', call, subscribeInvalidations: () => () => {} });
  expect(await runtime.createLink?.({ kind: 'page', page: 1 })).toBe('placekeeper:///Review.pdf#v=1&page=1');
  expect(call).toHaveBeenCalledWith('createLink', { location: { kind: 'page', page: 1 } });
  call.mockResolvedValueOnce({ link: 'https://untrusted.example/' });
  await expect(runtime.createLink?.({ kind: 'page', page: 1 })).rejects.toThrow('unavailable');
  runtime.dispose();
  await expect(runtime.createLink?.({ kind: 'page', page: 1 })).rejects.toThrow('disconnected');
});
