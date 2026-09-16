import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReviewInteractions } from '../../service/src/sessions/review-interactions.js';
import { createReviewState } from '../../../packages/core/src/review-model.js';
import { createBrowserHostRuntime } from '../src/host/browser-runtime.js';
import {
  attachmentOrderedInteractionTransport,
  beginReviewInteraction,
} from '../src/review/authoring-session.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('browser interaction reconnect barrier', () => {
  it('rehydrates canonical state and reacquires an actively typed editor before refresh continues', async () => {
    vi.useFakeTimers();
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const state = createReviewState({
      sessionId,
      source: { fileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', digest: 'a'.repeat(64), byteLength: 100 },
      documentGeneration: 4,
    });
    const broker = new ReviewInteractions({ currentGeneration: () => 4 });
    let attachment = broker.register(sessionId, 'browser-view');
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/state')) return Response.json(state);
      if (path.endsWith('/scope')) return Response.json({ documentTitle: 'paper.pdf', launchSurface: 'browser' });
      if (path.endsWith('/save/status')) return Response.json({
        destination: { phase: 'none', generation: 0 },
        sync: { phase: 'clean', desiredRevision: 0, savedRevision: 0 },
      });
      const action = path.match(/\/interactions\/(begin|finalize|release|acknowledge)$/u)?.[1];
      if (action !== undefined) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
          attachment: typeof attachment;
          interactionToken: string;
          order: number;
        };
        const authenticated = {
          sessionId,
          attachmentId: body.attachment.attachmentId,
          incarnationId: body.attachment.incarnationId,
          capability: body.attachment.capability,
          interactionToken: body.interactionToken,
          order: body.order,
        };
        if (action === 'begin') {
          return Response.json(await broker.begin({ ...authenticated, generation: body.generation as number }));
        }
        if (action === 'release') return Response.json(await broker.release(authenticated));
        if (action === 'acknowledge') return Response.json(await broker.acknowledge(authenticated));
        return Response.json(await broker.finalize({
          ...authenticated,
          outcome: body.outcome as 'applied' | 'discarded',
          reviewRevision: 1,
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    type SocketListener = (event: { data?: string }) => void;
    class FakeSocket {
      static created: FakeSocket[] = [];
      readonly listeners = new Map<string, Set<SocketListener>>();
      constructor(readonly url: string, readonly protocols: readonly string[]) {
        FakeSocket.created.push(this);
      }
      addEventListener(kind: string, listener: SocketListener) {
        let listeners = this.listeners.get(kind);
        if (listeners === undefined) {
          listeners = new Set();
          this.listeners.set(kind, listeners);
        }
        listeners.add(listener);
      }
      emit(kind: string, data?: unknown) {
        for (const listener of this.listeners.get(kind) ?? []) {
          listener(data === undefined ? {} : { data: JSON.stringify(data) });
        }
      }
      close() {}
    }
    vi.stubGlobal('location', new URL('http://127.0.0.1:43179/s/id/bootstrap'));
    vi.stubGlobal('window', { location: globalThis.location, setTimeout, clearTimeout });
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('WebSocket', FakeSocket);

    const runtime = createBrowserHostRuntime({ sessionId, credential: 'memory-only' });
    await runtime.bootstrap();
    const firstSocket = FakeSocket.created[0]!;
    firstSocket.emit('open');
    firstSocket.emit('message', { kind: 'interaction-attachment', attachment });
    await runtime.bootstrap();
    if (runtime.beginInteraction === undefined || runtime.finalizeInteraction === undefined ||
      runtime.releaseInteraction === undefined || runtime.acknowledgeInteraction === undefined) {
      throw new Error('Expected browser interaction lifecycle');
    }
    const lifecycle = attachmentOrderedInteractionTransport(runtime, {
      beginInteraction: runtime.beginInteraction,
      finalizeInteraction: runtime.finalizeInteraction,
      releaseInteraction: runtime.releaseInteraction,
      acknowledgeInteraction: runtime.acknowledgeInteraction,
    });
    const editor = await beginReviewInteraction(lifecycle, 4, 'actively-typed-editor');
    expect(broker.held(sessionId)).toBe(true);

    let reconnectBootstrap: Promise<unknown> | undefined;
    runtime.subscribeInteractionReconnect?.(async ({ generation }) => {
      expect(generation).toBe(4);
      await editor.reacquire();
    });
    runtime.subscribeInvalidations(() => { reconnectBootstrap = runtime.bootstrap(); });

    broker.disconnect(attachment.attachmentId, attachment.incarnationId);
    firstSocket.emit('close');
    expect(broker.held(sessionId)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    const replacementSocket = FakeSocket.created[1]!;
    expect(replacementSocket.protocols[3]).toBe(firstSocket.protocols[3]);
    expect(replacementSocket.protocols[3]).toMatch(/^placekeeper-owner\.[A-Za-z0-9_-]{43}$/u);
    replacementSocket.emit('open');
    await vi.advanceTimersByTimeAsync(0);
    expect(reconnectBootstrap).toBeDefined();
    let refreshContinued = false;
    void reconnectBootstrap!.then(() => { refreshContinued = true; });
    await Promise.resolve();
    expect(refreshContinued).toBe(false);

    attachment = broker.register(sessionId, 'browser-view');
    replacementSocket.emit('message', { kind: 'interaction-attachment', attachment });
    await reconnectBootstrap;

    expect(broker.held(sessionId)).toBe(true);
    expect(refreshContinued).toBe(true);
    lifecycle.dispose();
    runtime.dispose();
  });
});
