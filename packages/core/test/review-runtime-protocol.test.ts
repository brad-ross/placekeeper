import { describe, expect, it } from "vitest";

import {
  DOCUMENT_RUNTIME_HOSTS,
  DOCUMENT_RUNTIME_HOST_METHODS,
  DOCUMENT_RUNTIME_METHODS,
  DOCUMENT_RUNTIME_PROTOCOL,
  DOCUMENT_RUNTIME_VERSION,
  isDocumentRuntimeMethodForHost,
  isDocumentPanelKey,
  isDocumentRuntimeMethod,
  sanitizeChromeDocumentRuntimeRequest,
  sanitizeChromeDocumentRuntimeResponse,
  sanitizeCodexDocumentRuntimeResponse,
  sanitizeMacosDocumentRuntimeRequest,
  sanitizeMacosDocumentRuntimeResponse,
  sanitizeDocumentRuntimeDisplayString,
} from "../src/review-runtime-protocol.js";
import { addPageNote } from "../src/review-commands.js";
import { reduceDocument } from "../src/review-reducer.js";
import { createDocumentState } from "../src/review-model.js";
import { chromeRuntimeProjectionChangeReason } from "../src/chrome-native-runtime-protocol.js";

describe("shared review runtime protocol", () => {
  it("keeps long editing histories out of native state transport without losing undo/redo positions", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      id: `annotation-${index}`, kind: "highlight", pageIndex: 0,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      payload: { quote: "Selected text", comment: "Review comment", reliable: true,
        rect: { x: 10, y: 10, width: 100, height: 10 },
        segmentRects: [{ x: 10, y: 10, width: 100, height: 10 }] },
    }));
    const history = Array.from({ length: 300 }, () => ({ beforeItems: items, afterItems: items }));
    const state = { ...createDocumentState({
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      source: { fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", digest: "a".repeat(64), byteLength: 100 },
    }), items, history, historyCursor: 299, revision: 300 };
    for (const sanitize of [sanitizeChromeDocumentRuntimeResponse, sanitizeMacosDocumentRuntimeResponse]) {
      const projected = sanitize("command", state);
      expect(projected).toMatchObject({ items, history: { length: 300 }, historyCursor: 299 });
      expect(JSON.stringify(projected).length).toBeLessThan(10_000);
      // Both the service and client validate responses. A second pass must preserve the summary.
      expect(sanitize("command", projected)).toEqual(projected);
      expect(sanitize("command", { accepted: false, state, message: "Revision conflict" }))
        .toMatchObject({ accepted: false, state: projected });
      expect(sanitize("command", { ...state, items: [{ ...items[0], credential: "must-not-cross" }] }))
        .toBeUndefined();
    }
    expect(state.history).toBe(history);
    expect(state.history[299]!.beforeItems).toBe(items);
    // The response fix must not relax the incoming-command budget.
    for (const sanitize of [sanitizeChromeDocumentRuntimeRequest, sanitizeMacosDocumentRuntimeRequest]) {
      expect(sanitize("command", { type: "edit", expectedRevision: 300, id: "annotation-0",
        updatedAt: "2026-01-01T00:00:00Z", payload: { history } })).toBeUndefined();
    }
  });

  it('projects compact command history while retaining canonical undo and redo', () => {
    let state = createDocumentState({ sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      source: { fileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', digest: 'a'.repeat(64), byteLength: 100 } });
    state = reduceDocument(state, addPageNote(state, 0, { x: 10, y: 10, width: 18, height: 18 }, 'Keep', {
      createId: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', now: () => '2026-08-07T12:00:00.000Z',
    }));
    expect(state.history[0]).toMatchObject({ schemaVersion: 1, itemChanges: [{ before: null }] });
    state = reduceDocument(state, { type: 'undo', expectedRevision: state.revision });
    for (const sanitize of [sanitizeChromeDocumentRuntimeResponse, sanitizeMacosDocumentRuntimeResponse]) {
      const view = sanitize('command', state);
      expect(view).toMatchObject({ items: [], history: { length: 1 }, historyCursor: 0 });
      expect(sanitize('command', view)).toEqual(view);
      expect(JSON.stringify(view)).not.toContain('itemChanges');
    }
    state = reduceDocument(state, { type: 'redo', expectedRevision: state.revision });
    expect(state.items[0]?.payload.comment).toBe('Keep');
  });

  it("preserves canonical never-saved revision -1 across shared native hosts", () => {
    const status = { destination: { phase: "none", generation: 0 },
      sync: { phase: "not-saved", desiredRevision: 1, savedRevision: -1 } };
    for (const sanitize of [sanitizeChromeDocumentRuntimeResponse, sanitizeMacosDocumentRuntimeResponse, sanitizeCodexDocumentRuntimeResponse]) {
      expect(sanitize("saveStatus", status)).toMatchObject(status);
      expect(sanitize("saveStatus", { ...status, sync: { ...status.sync, savedRevision: -2 } })).toBeUndefined();
      expect(sanitize("saveStatus", { ...status, sync: { ...status.sync, savedRevision: -0.5 } })).toBeUndefined();
    }
  });
  it("detects exact authoring presence changes at an equal review revision", () => {
    const projection = { generation: 1, revision: 4, saveStatus: {}, state: {}, activeAuthoringDraftIds: [] };
    expect(chromeRuntimeProjectionChangeReason(projection, {
      ...projection,
      activeAuthoringDraftIds: ["draft_authoring_1234"],
    })).toBe("presence");
    expect(chromeRuntimeProjectionChangeReason(
      { ...projection, activeAuthoringDraftIds: undefined },
      projection,
    )).toBeUndefined();
  });
  it("preserves export fences and rejects malformed fences at host boundaries", () => {
    const payload = { confirmPossiblyStale: true, fence: { expectedRevision: 3, documentGeneration: 1 } };
    for (const sanitize of [sanitizeChromeDocumentRuntimeRequest, sanitizeMacosDocumentRuntimeRequest]) {
      expect(sanitize("exportReviewedCopy", payload)).toEqual(payload);
      for (const fence of [{ expectedRevision: -1, documentGeneration: 1 }, { expectedRevision: 3 },
        { expectedRevision: 3, documentGeneration: 0 }, { ...payload.fence, path: "/private" }]) {
        expect(sanitize("exportReviewedCopy", { fence })).toBeUndefined();
      }
    }
  });
  it("transports only well-shaped document annotation name commands", () => {
    const command = { type: "set-annotation-name", expectedRevision: 2, annotationName: "Brad Ross" };
    expect(sanitizeChromeDocumentRuntimeRequest("command", command)).toEqual(command);
    expect(sanitizeChromeDocumentRuntimeRequest("command", { ...command, annotationName: 42 })).toBeUndefined();
    expect(sanitizeChromeDocumentRuntimeRequest("command", { ...command, preference: true })).toBeUndefined();
  });

  it("transports destination name confirmation and sanitizes its canonical result", () => {
    const confirmation = { command: { type: "set-annotation-name", expectedRevision: 2, annotationName: "Brad Ross" }, expectedGeneration: 1 };
    const state = createDocumentState({ sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      source: { fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", digest: "a".repeat(64), byteLength: 100 } });
    const status = { destination: { phase: "none", generation: 0 }, sync: { phase: "clean", desiredRevision: 0, savedRevision: 0 } };
    for (const method of ["chooseCopy", "chooseOriginal"] as const) {
      expect(sanitizeChromeDocumentRuntimeRequest(method, { confirmation })).toEqual({ confirmation });
      expect(sanitizeChromeDocumentRuntimeRequest(method, { confirmation: { ...confirmation, expectedGeneration: -1 } })).toBeUndefined();
      expect(sanitizeChromeDocumentRuntimeRequest(method, { confirmation: { ...confirmation, command: { type: "undo", expectedRevision: 2 } } })).toBeUndefined();
      expect(sanitizeChromeDocumentRuntimeRequest(method, { confirmation: { ...confirmation, preference: true } })).toBeUndefined();
      expect(sanitizeChromeDocumentRuntimeResponse(method, { ...status, nameResult: state }))
        .toMatchObject({ nameResult: { sessionId: state.sessionId } });
      const unsafe = sanitizeChromeDocumentRuntimeResponse(method, { ...status, nameResult: { ...state, credential: "secret" } });
      expect(unsafe === undefined || !JSON.stringify(unsafe).includes("secret")).toBe(true);
      expect(sanitizeChromeDocumentRuntimeResponse(method, { ...status, nameResult: { accepted: false, state, message: "Annotation name is too long" } }))
        .toMatchObject({ nameResult: { accepted: false, message: "Annotation name is too long" } });
    }
  });

  it("defines the complete versioned method vocabulary for both hosts", () => {
    expect(DOCUMENT_RUNTIME_PROTOCOL).toBe("placekeeper.review-runtime");
    expect(DOCUMENT_RUNTIME_VERSION).toBe(4);
    expect(DOCUMENT_RUNTIME_METHODS).toEqual([
      "upgradePoll",
      "upgradeSettle",
      "bootstrap",
      "presence",
      "detach",
      "command",
      "beginInteraction",
      "finalizeInteraction",
      "releaseInteraction",
      "acknowledgeInteraction",
      "saveStatus",
      "saveProposal",
      "chooseCopy",
      "chooseFolder",
      "chooseOriginal",
      "retrySave",
      "locateSave",
      "scope",
      "forwardSyncTex",
      "reverseSyncTex",
      "resolveReadingLocation",
      "exportReviewedCopy",
    ]);
  });

  it("accepts only methods in the shared vocabulary", () => {
    for (const method of DOCUMENT_RUNTIME_METHODS) expect(isDocumentRuntimeMethod(method)).toBe(true);
    expect(isDocumentRuntimeMethod("unknown")).toBe(false);
    expect(isDocumentRuntimeMethod(1)).toBe(false);
  });

  it("recognizes opaque review panel keys without accepting arbitrary strings", () => {
    expect(isDocumentPanelKey("opaque-panel-key")).toBe(true);
    expect(isDocumentPanelKey("short")).toBe(false);
    expect(isDocumentPanelKey("unsafe/panel/key")).toBe(false);
    expect(isDocumentPanelKey(undefined)).toBe(false);
  });

  it("keeps native SyncTeX payloads path-free while accepting geometry and acknowledgements", () => {
    expect(sanitizeMacosDocumentRuntimeRequest("forwardSyncTex", { action: "poll" })).toEqual({ action: "poll" });
    expect(sanitizeMacosDocumentRuntimeRequest("forwardSyncTex", { action: "poll", sourcePath: "/private/main.tex" })).toBeUndefined();
    expect(sanitizeMacosDocumentRuntimeRequest("reverseSyncTex", { pageIndex: 0, point: { x: 5, y: 6 }, profile: "other" })).toBeUndefined();
    expect(sanitizeMacosDocumentRuntimeResponse("reverseSyncTex", { status: "opened", path: "/private/main.tex", session: "secret" })).toEqual({ status: "opened" });
    expect(sanitizeMacosDocumentRuntimeResponse("forwardSyncTex", { status: "ready", sequence: 1, generation: 2,
      pageIndex: 0, point: { x: 5, y: 6 }, sourceRoot: "/private" })).toEqual({ status: "ready", sequence: 1, generation: 2, pageIndex: 0, point: { x: 5, y: 6 } });
    expect(sanitizeChromeDocumentRuntimeRequest("forwardSyncTex", { action: "poll" })).toBeUndefined();
  });

  it("defines Chrome as a reduced, compiler-visible RPC host", () => {
    expect(DOCUMENT_RUNTIME_HOSTS).toEqual(["vscode", "chrome", "macos", "electron", "codex"]);
    expect(DOCUMENT_RUNTIME_HOST_METHODS.vscode).toEqual(DOCUMENT_RUNTIME_METHODS);
    expect(DOCUMENT_RUNTIME_HOST_METHODS.codex).toEqual(DOCUMENT_RUNTIME_HOST_METHODS.chrome);
    expect(DOCUMENT_RUNTIME_HOST_METHODS.chrome).not.toContain("forwardSyncTex");
    expect(DOCUMENT_RUNTIME_HOST_METHODS.chrome).not.toContain("reverseSyncTex");
    expect(isDocumentRuntimeMethodForHost("chrome", "command")).toBe(true);
    expect(isDocumentRuntimeMethodForHost("chrome", "reverseSyncTex")).toBe(false);
    expect(DOCUMENT_RUNTIME_HOST_METHODS.electron).toEqual(DOCUMENT_RUNTIME_HOST_METHODS.vscode);
    expect(isDocumentRuntimeMethodForHost("electron", "command")).toBe(true);
    expect(isDocumentRuntimeMethodForHost("electron", "reverseSyncTex")).toBe(true);
    expect(DOCUMENT_RUNTIME_HOST_METHODS.macos).toEqual(DOCUMENT_RUNTIME_HOST_METHODS.vscode);
    expect(isDocumentRuntimeMethodForHost("macos", "command")).toBe(true);
    expect(isDocumentRuntimeMethodForHost("macos", "reverseSyncTex")).toBe(true);
  });

  it("projects the Mac runtime without paths, capabilities, or a link base", () => {
    expect(sanitizeMacosDocumentRuntimeRequest("command", {
      type: "undo",
      expectedRevision: 0,
    })).toEqual({ type: "undo", expectedRevision: 0 });
    expect(sanitizeMacosDocumentRuntimeResponse("scope", {
      documentTitle: "Paper.pdf",
      sourceDisplayName: "Paper.pdf",
      sourceDisposition: "local",
      launchSurface: "macos",
      sourceRootPath: "/Users/reader/private",
      credential: "must-not-cross",
    })).toEqual({
      documentTitle: "Paper.pdf",
      sourceDisplayName: "Paper.pdf",
      sourceDisposition: "local",
      launchSurface: "macos",
    });
  });

  it("accepts only closed Chrome request payloads without capability primitives", () => {
    expect(sanitizeChromeDocumentRuntimeRequest("beginInteraction", {
      interactionToken: "interaction_token_1234",
      order: 1,
      generation: 1,
      draftId: "draft_identifier_1234",
    })).toEqual({
      interactionToken: "interaction_token_1234",
      order: 1,
      generation: 1,
      draftId: "draft_identifier_1234",
    });
    expect(sanitizeChromeDocumentRuntimeRequest("beginInteraction", {
      interactionToken: "interaction_token_1234",
      order: 1,
      generation: 1,
      draftId: "unsafe/draft",
    })).toBeUndefined();
    expect(sanitizeChromeDocumentRuntimeRequest("chooseCopy", {
      filename: "Reviewed.pdf",
      folderSelectionId: "opaque_folder_selection_1234",
    })).toEqual({ filename: "Reviewed.pdf", folderSelectionId: "opaque_folder_selection_1234" });
    expect(sanitizeChromeDocumentRuntimeRequest("chooseCopy", {
      filename: "Reviewed.pdf",
      credential: "secret",
    })).toBeUndefined();
    expect(sanitizeChromeDocumentRuntimeRequest("command", {
      type: "undo",
      expectedRevision: 3,
      headers: { authorization: "secret" },
    })).toBeUndefined();
    expect(sanitizeChromeDocumentRuntimeRequest("forwardSyncTex", {})).toBeUndefined();
  });

  it("bounds reading passage requests and closes their response shape", () => {
    const request = {
      generation: 2,
      anchor: {
        kind: "caret",
        pageIndex: 1,
        leftContext: "left passage",
        rightContext: "right passage",
        rect: { x: 10, y: 20, width: 1, height: 8 },
      },
    };
    for (const sanitize of [sanitizeChromeDocumentRuntimeRequest, sanitizeMacosDocumentRuntimeRequest]) {
      expect(sanitize("resolveReadingLocation", request)).toEqual(request);
      expect(sanitize("resolveReadingLocation", {
        ...request,
        anchor: { ...request.anchor, leftContext: "x".repeat(65) },
      })).toBeUndefined();
      expect(sanitize("resolveReadingLocation", { ...request, sessionId: "foreign" })).toBeUndefined();
      expect(sanitize("resolveReadingLocation", { ...request, generation: 0 })).toBeUndefined();
    }
    expect(sanitizeChromeDocumentRuntimeResponse("resolveReadingLocation", {
      status: "resolved", generation: 2, pageIndex: 3,
      rect: { x: 20, y: 30, width: 1, height: 8 },
    })).toEqual({
      status: "resolved", generation: 2, pageIndex: 3,
      rect: { x: 20, y: 30, width: 1, height: 8 },
    });
    expect(sanitizeChromeDocumentRuntimeResponse("resolveReadingLocation", {
      status: "resolved", generation: 2, pageIndex: 3,
      rect: { x: 20, y: 30, width: 1, height: 8 },
      sourcePath: "/private/paper.pdf",
    })).toBeUndefined();
  });

  it("projects native annotation import state without task, bind, path, credential, or executable authority", () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const state = {
      ...createDocumentState({
        sessionId,
        source: {
          fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          digest: "a".repeat(64),
          byteLength: 100,
        },
        sourceRootId: "must-not-cross",
      }),
      nativeAnnotationImportDigest: "a".repeat(64),
      annotationName: "Brad Ross",
    };
    const bootstrap = {
      sessionId,
      generation: 1,
      revision: 0,
      state,
      scope: {
        documentTitle: "Paper.pdf",
        sourceDisposition: "remote-temporary",
        sourceDisplayName: "Paper.pdf",
        launchSurface: "chrome",
        sourceRootPath: "/Users/reader/secret",
        codexContext: { taskId: "task-secret", bindProof: "proof-secret" },
      },
      saveStatus: {
        destination: { phase: "none", generation: 0 },
        sync: { phase: "clean", desiredRevision: 0, savedRevision: 0 },
      },
      activeAuthoringDraftIds: ["draft_authoring_1234"],
      resources: {
        document: "blob:chrome-extension://abcdefghijklmnopabcdefghijklmnop/document",
        pdfiumWasm: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/assets/pdfium.wasm",
        worker: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/assets/pdfium-worker.js",
      },
      canonicalLinkBase: "placekeeper:///Papers/Paper.pdf",
      location: { kind: "page", page: 4 },
    };
    const projected = sanitizeChromeDocumentRuntimeResponse("bootstrap", bootstrap);

    expect(projected).toMatchObject({
      state: { nativeAnnotationImportDigest: "a".repeat(64), annotationName: "Brad Ross" },
      scope: { documentTitle: "Paper.pdf", launchSurface: "chrome" },
      canonicalLinkBase: "placekeeper:///Papers/Paper.pdf",
      location: { kind: "page", page: 4 },
      activeAuthoringDraftIds: ["draft_authoring_1234"],
    });
    const serialized = JSON.stringify(projected);
    for (const canary of ["must-not-cross", "/Users/reader/secret", "task-secret", "proof-secret"]) {
      expect(serialized).not.toContain(canary);
    }
    const macosProjected = sanitizeMacosDocumentRuntimeResponse("bootstrap", {
      ...bootstrap,
      scope: { ...bootstrap.scope, launchSurface: "macos" },
    });
    expect(macosProjected).toMatchObject({
      state: { nativeAnnotationImportDigest: "a".repeat(64), annotationName: "Brad Ross" },
      scope: { documentTitle: "Paper.pdf", launchSurface: "macos" },
      activeAuthoringDraftIds: ["draft_authoring_1234"],
    });
    expect(macosProjected).not.toHaveProperty("canonicalLinkBase");
    expect(sanitizeChromeDocumentRuntimeResponse("bootstrap", {
      ...bootstrap,
      activeAuthoringDraftIds: ["draft_authoring_1234", "draft_authoring_1234"],
    })).toBeUndefined();
    const { activeAuthoringDraftIds: _activeAuthoringDraftIds, ...legacyBootstrap } = bootstrap;
    expect(sanitizeChromeDocumentRuntimeResponse("bootstrap", legacyBootstrap))
      .toMatchObject({ activeAuthoringDraftIds: [] });
    for (const invalidDigest of [new String("a".repeat(64)), "A".repeat(64), "a".repeat(63)]) {
      expect(sanitizeChromeDocumentRuntimeResponse("command", {
        ...state,
        nativeAnnotationImportDigest: invalidDigest,
      })).toBeUndefined();
    }
  });

  it("fails closed on forbidden Chrome response primitives and capability-bearing links", () => {
    expect(sanitizeChromeDocumentRuntimeResponse("scope", {
      documentTitle: "Paper.pdf",
      launchSurface: "chrome",
      credential: "secret",
    })).toBeUndefined();
    expect(sanitizeChromeDocumentRuntimeResponse("bootstrap", {
      canonicalLinkBase: "placekeeper:///Paper.pdf#credential=secret",
    })).toBeUndefined();
    expect(sanitizeChromeDocumentRuntimeResponse("bootstrap", {
      canonicalLinkBase: "placekeeper:///https%3A%2F%2Fexample.com%2Fsecret.pdf",
    })).toBeUndefined();
    expect(sanitizeChromeDocumentRuntimeResponse("forwardSyncTex", {})).toBeUndefined();
  });

  it("bounds Chrome-facing titles and removes control and bidirectional overrides", () => {
    expect(sanitizeDocumentRuntimeDisplayString("  Quarterly\n\u202eResults  "))
      .toBe("Quarterly Results");
    expect([...sanitizeDocumentRuntimeDisplayString("x".repeat(300))!]).toHaveLength(255);
  });

  it("never forwards injected credentials from any Chrome response class", () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const state = createDocumentState({
      sessionId,
      source: {
        fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        digest: "a".repeat(64),
        byteLength: 100,
      },
    });
    const saveStatus = {
      destination: { phase: "none", generation: 0 },
      sync: { phase: "clean", desiredRevision: 0, savedRevision: 0 },
      credential: "response-canary",
    };
    const cases = [
      ["presence", { credential: "response-canary" }],
      ["detach", { credential: "response-canary" }],
      ["command", { ...state, credential: "response-canary" }],
      ["saveStatus", saveStatus],
      ["saveProposal", { sourceDisposition: "local", filename: "Paper.pdf", folder: "/secret", credential: "response-canary" }],
      ["chooseCopy", saveStatus],
      ["chooseFolder", { cancelled: false, selectionId: "opaque_selection_1234", folder: "/secret", credential: "response-canary" }],
      ["chooseOriginal", saveStatus],
      ["retrySave", saveStatus],
      ["locateSave", saveStatus],
      ["scope", { documentTitle: "Paper.pdf", launchSurface: "chrome", credential: "response-canary" }],
      ["exportReviewedCopy", { kind: "reviewed-copy", path: "/secret", revision: 0, digest: "b".repeat(64), credential: "response-canary" }],
    ] as const;

    for (const [method, value] of cases) {
      const projected = sanitizeChromeDocumentRuntimeResponse(method, value);
      expect(projected === undefined || !JSON.stringify(projected).includes("response-canary"), method)
        .toBe(true);
    }
  });

  it("preserves the remote-temporary save proposal without inventing a local filename", () => {
    expect(sanitizeChromeDocumentRuntimeResponse("saveProposal", {
      sourceDisposition: "remote-temporary",
    })).toEqual({ sourceDisposition: "remote-temporary" });
    expect(sanitizeChromeDocumentRuntimeResponse("saveProposal", {
      sourceDisposition: "remote-temporary",
      folder: "/private/source",
    })).toBeUndefined();
  });

  it.each(["local", "remote-temporary"])("preserves %s download defaults without exposing the native folder", (sourceDisposition) => {
    expect(sanitizeChromeDocumentRuntimeResponse("saveProposal", {
      sourceDisposition, filename: "Original paper.pdf", folder: "/private/custom-downloads",
      folderSelectionId: "download-selection",
    })).toEqual({ sourceDisposition, filename: "Original paper.pdf",
      folder: "Chrome downloads folder", folderSelectionId: "download-selection" });
    expect(sanitizeChromeDocumentRuntimeResponse("saveProposal", {
      sourceDisposition, filename: "Original paper.pdf", folder: "/private/custom-downloads",
      folderSelectionId: "../invalid",
    })).toBeUndefined();
  });

  it("fails closed instead of forwarding raw save and export errors", () => {
    expect(sanitizeChromeDocumentRuntimeResponse("saveStatus", {
      destination: { phase: "none", generation: 0 },
      sync: {
        phase: "not-saved",
        desiredRevision: 2,
        savedRevision: 1,
        failure: "/Users/reader/private.pdf: EACCES",
      },
    })).toBeUndefined();
    expect(sanitizeChromeDocumentRuntimeResponse("exportReviewedCopy", {
      kind: "reviewed-copy",
      path: "/Users/reader/private.pdf",
      revision: 2,
      digest: "b".repeat(64),
      warning: "stack trace with /Users/reader/private.pdf",
    })).toBeUndefined();
  });
});

it('projects only closed path-free native context status and identity', () => {
  const identity = { placekeeperSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', documentGeneration: 1, reviewRevision: 2,
    source: { fileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', digest: 'a'.repeat(64), byteLength: 4 }, stateDigest: 'b'.repeat(64) };
  const scope = { documentTitle: 'Review.pdf', codexContext: { status: 'current', identity, leaseExpiresAt: '2026-10-05T12:00:00.000Z' } };
  expect(sanitizeCodexDocumentRuntimeResponse('scope', scope)).toMatchObject({ launchSurface: 'codex', codexContext: scope.codexContext });
  for (const codexContext of [{ ...scope.codexContext, taskId: 'private' }, { ...scope.codexContext, identity: { ...identity, path: '/private/review.pdf' } }, { ...scope.codexContext, identity: { ...identity, stateDigest: 'wrong' } }]) {
    expect(sanitizeCodexDocumentRuntimeResponse('scope', { ...scope, codexContext })).toBeUndefined();
  }
});

it('keeps upgrade settlement credentials and durability authority off renderer transports', () => {
  const request = { attemptId: 'a'.repeat(43) };
  for (const method of ['upgradePoll', 'upgradeSettle'] as const) {
    expect(sanitizeChromeDocumentRuntimeResponse(method, { phase: 'preparing', attemptId: request.attemptId, settlementRequired: true })).toEqual({ phase: 'preparing', attemptId: request.attemptId, settlementRequired: true });
    expect(sanitizeChromeDocumentRuntimeResponse(method, { phase: 'preparing', attemptId: request.attemptId, token: 'b'.repeat(43) })).toBeUndefined();
  }
  expect(sanitizeChromeDocumentRuntimeRequest('upgradeSettle', request)).toEqual(request);
  expect(sanitizeChromeDocumentRuntimeRequest('upgradeSettle', { ...request, reviewRevisionDurable: true })).toBeUndefined();
  expect(sanitizeChromeDocumentRuntimeRequest('upgradeSettle', { ...request, participantToken: 'b'.repeat(43) })).toBeUndefined();
  expect(sanitizeChromeDocumentRuntimeRequest('upgradePoll', { token: 'b'.repeat(43) })).toBeUndefined();
});
