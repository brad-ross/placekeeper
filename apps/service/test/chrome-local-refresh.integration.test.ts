import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createNativeEmbeddedReview } from "../../chrome-extension/src/chrome-runtime.js";
import type { NativePort } from "../../chrome-extension/src/chrome-api.js";
import { createRpcHostRuntime } from "../../web/src/host/vscode-runtime.js";
import { anchorEvidenceFromReviewItem } from "../../../packages/core/src/review-model.js";
import type { ReviewItem } from "../../../packages/core/src/review-model.js";
import { PlacekeeperHost } from "../src/host/placekeeper-host.js";

const extensionOrigin = "chrome-extension://cgegjjjhbhnfgcoipeffhogoojfoekgg";
const roots: string[] = [];
const hosts: PlacekeeperHost[] = [];

class NativeEvent<T> {
  readonly #listeners = new Set<(value: T) => void>();
  addListener(listener: (value: T) => void): void { this.#listeners.add(listener); }
  removeListener(listener: (value: T) => void): void { this.#listeners.delete(listener); }
  emit(value: T): void { for (const listener of this.#listeners) listener(value); }
}

function nativePort(host: PlacekeeperHost, portId: string): NativePort {
  const onMessage = new NativeEvent<unknown>();
  const onDisconnect = new NativeEvent<void>();
  let queue = Promise.resolve();
  let disconnected = false;
  return {
    onMessage,
    onDisconnect,
    postMessage(message) {
      queue = queue.then(async () => {
        if (disconnected) return;
        const replies = await host.chromeRuntime.handle(portId, message);
        for (const reply of replies) onMessage.emit(reply);
      });
    },
    disconnect() {
      if (disconnected) return;
      disconnected = true;
      void queue.finally(async () => {
        await host.chromeRuntime.detach(portId);
        onDisconnect.emit();
      });
    },
  };
}

async function pdf(text: string, leadingBlankPages = 0): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let index = 0; index < leadingBlankPages; index += 1) document.addPage([420, 300]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([420, 300]);
  page.drawText(text, { x: 48, y: 210, font, size: 14 });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

function anchoredItem(id: string, quote: string): ReviewItem {
  return {
    id,
    kind: "highlight",
    pageIndex: 0,
    createdAt: "2026-09-16T12:00:00.000Z",
    updatedAt: "2026-09-16T12:00:00.000Z",
    payload: {
      quote,
      prefix: "",
      suffix: "",
      reliable: true,
      rect: { x: 48, y: 75, width: 210, height: 14 },
      segmentRects: [{ x: 48, y: 75, width: 210, height: 14 }],
      comment: "Created while the successor waited.",
    },
  };
}

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local Chrome automatic refresh integration", () => {
  it("carries a real rewritten PDF through the observer, Chrome resource delivery, and shared runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-chrome-refresh-"));
    roots.push(root);
    const pdfPath = join(root, "paper.pdf");
    const quote = "Anchor sentence survives refresh";
    const original = await pdf(quote);
    const successor = await pdf(quote, 1);
    const newest = await pdf(`${quote} with a newer ending`, 2);
    await writeFile(pdfPath, original);

    const host = await PlacekeeperHost.start({ recoveryRoot: join(root, "recovery") });
    hosts.push(host);
    let sequence = 0;
    const blobs = new Map<string, Blob>();
    const revoked: string[] = [];
    const open = createNativeEmbeddedReview({
      connectNative: () => nativePort(host, `chrome-integration-port-${++sequence}`),
      fetchStream: vi.fn(async () => { throw new Error("A local PDF must not use the browser stream."); }),
      createId: () => `chrome_integration_${String(++sequence).padStart(8, "0")}`,
      createObjectURL(blob) {
        const url = `blob:${extensionOrigin}/document-${++sequence}`;
        blobs.set(url, blob);
        return url;
      },
      revokeObjectURL(url) { revoked.push(url); },
      getExtensionURL: (path) => `${extensionOrigin}/${path}`,
      interactionOwnerSecret: () => "s".repeat(43),
      timeoutMs: 10_000,
    });
    const embedded = await open({
      originalUrl: pathToFileURL(pdfPath).href,
      streamUrl: "blob:chrome-authorized-stream-must-remain-unused",
      tabId: 41,
    });
    const runtime = createRpcHostRuntime(embedded.runtimePort, { host: "chrome", extensionOrigin });
    const initial = await runtime.bootstrap();
    expect(initial).toMatchObject({ generation: 1, scope: { sourceDisposition: "local", launchSurface: "chrome" } });
    expect(Buffer.from(await blobs.get(initial.viewerAssets.documentUrl)!.arrayBuffer())).toEqual(original);
    await embedded.activate();
    const generationTwoEvent = Promise.withResolvers<void>();
    const unsubscribe = runtime.subscribeInvalidations((event) => {
      if (event.generation === 2) generationTwoEvent.resolve();
    });

    const interactionToken = "chrome_runtime_interaction_0001";
    const begun = await runtime.beginInteraction!({ interactionToken, order: 1, generation: 1 });
    expect(begun).toMatchObject({ status: "accepted", generation: 1 });
    const ownerViewId = (begun as { readonly ownerViewId: string }).ownerViewId;
    const draftId = randomUUID();
    await runtime.command({
      type: "put-draft",
      expectedRevision: 0,
      expectedDraftRevision: -1,
      draft: {
        id: draftId,
        ownerViewId,
        baseGeneration: 1,
        revision: 0,
        kind: "highlight",
        pageIndex: 0,
        text: "Created while the successor waited.",
        anchor: anchorEvidenceFromReviewItem(anchoredItem(draftId, quote)),
        disposition: { kind: "resolved", generation: 1 },
        status: "protected",
        createdAt: "2026-09-16T12:00:00.000Z",
        updatedAt: "2026-09-16T12:00:00.000Z",
      },
    });
    expect(host.broker.state(initial.sessionId)).toMatchObject({
      pendingDrafts: [{ id: draftId, ownerViewId, status: "protected" }],
    });
    await writeFile(pdfPath, successor);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(host.broker.state(initial.sessionId)?.workflow.documentGeneration).toBe(1);

    const receipt = await runtime.finalizeInteraction!({
      interactionToken,
      order: 2,
      outcome: "applied",
      draftId,
      expectedDraftRevision: 0,
    });
    expect(receipt).toMatchObject({ status: "finalized", interactionToken, outcome: "applied" });
    await expect(runtime.acknowledgeInteraction!({ interactionToken, order: 3 }))
      .resolves.toMatchObject({ status: "released" });

    await vi.waitFor(() => expect(host.broker.state(initial.sessionId)).toMatchObject({
      workflow: { documentGeneration: 2, freshness: "current" },
      items: [{ id: draftId, reconciliation: { disposition: { kind: "resolved", generation: 2 } } }],
    }), { timeout: 12_000, interval: 100 });
    await generationTwoEvent.promise;
    const second = await runtime.bootstrap();
    expect(second.generation).toBe(2);
    expect(Buffer.from(await blobs.get(second.viewerAssets.documentUrl)!.arrayBuffer())).toEqual(successor);
    embedded.confirmDocumentReady(2);
    expect(revoked).toEqual([initial.viewerAssets.documentUrl]);

    await writeFile(pdfPath, "%PDF-1.7\ntruncated");
    await vi.waitFor(() => expect(host.broker.state(initial.sessionId)).toMatchObject({
      workflow: { documentGeneration: 2, freshness: "possibly-stale" },
    }), { timeout: 12_000, interval: 100 });
    await vi.waitFor(async () => {
      const stale = await runtime.bootstrap();
      expect(stale).toMatchObject({ generation: 2, state: { workflow: { freshness: "possibly-stale" } } });
    }, { timeout: 12_000, interval: 250 });
    expect(Buffer.from(await blobs.get(second.viewerAssets.documentUrl)!.arrayBuffer())).toEqual(successor);

    await writeFile(pdfPath, newest);
    await vi.waitFor(() => expect(host.broker.state(initial.sessionId)).toMatchObject({
      workflow: { documentGeneration: 3, freshness: "current" },
    }), { timeout: 12_000, interval: 100 });
    await vi.waitFor(async () => {
      const current = await runtime.bootstrap();
      expect(current.generation).toBe(3);
    }, { timeout: 12_000, interval: 250 });
    const third = await runtime.bootstrap();
    expect(Buffer.from(await blobs.get(third.viewerAssets.documentUrl)!.arrayBuffer())).toEqual(newest);
    embedded.confirmDocumentReady(3);
    expect(revoked).toEqual([initial.viewerAssets.documentUrl, second.viewerAssets.documentUrl]);

    await writeFile(pdfPath, await readFile(pdfPath));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(host.broker.state(initial.sessionId)?.workflow.documentGeneration).toBe(3);
    expect(blobs).toHaveLength(3);

    unsubscribe();
    runtime.dispose();
    await embedded.release();
    embedded.dispose();
  }, 45_000);
});
