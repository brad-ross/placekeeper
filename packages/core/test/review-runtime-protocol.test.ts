import { describe, expect, it } from "vitest";

import {
  REVIEW_RUNTIME_HOSTS,
  REVIEW_RUNTIME_HOST_METHODS,
  REVIEW_RUNTIME_METHODS,
  REVIEW_RUNTIME_PROTOCOL,
  REVIEW_RUNTIME_VERSION,
  isReviewRuntimeMethodForHost,
  isReviewPanelKey,
  isReviewRuntimeMethod,
  sanitizeChromeReviewRuntimeRequest,
  sanitizeChromeReviewRuntimeResponse,
  sanitizeCodexReviewRuntimeResponse,
  sanitizeMacosReviewRuntimeRequest,
  sanitizeMacosReviewRuntimeResponse,
  sanitizeReviewRuntimeDisplayString,
} from "../src/review-runtime-protocol.js";
import { addPageNote } from "../src/review-commands.js";
import { reduceReview } from "../src/review-reducer.js";
import { createReviewState } from "../src/review-model.js";
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
    const state = { ...createReviewState({
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      source: { fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", digest: "a".repeat(64), byteLength: 100 },
    }), items, history, historyCursor: 299, revision: 300 };
    for (const sanitize of [sanitizeChromeReviewRuntimeResponse, sanitizeMacosReviewRuntimeResponse]) {
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
    for (const sanitize of [sanitizeChromeReviewRuntimeRequest, sanitizeMacosReviewRuntimeRequest]) {
      expect(sanitize("command", { type: "edit", expectedRevision: 300, id: "annotation-0",
        updatedAt: "2026-01-01T00:00:00Z", payload: { history } })).toBeUndefined();
    }
  });

  it('projects compact command history while retaining canonical undo and redo', () => {
    let state = createReviewState({ sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      source: { fileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', digest: 'a'.repeat(64), byteLength: 100 } });
    state = reduceReview(state, addPageNote(state, 0, { x: 10, y: 10, width: 18, height: 18 }, 'Keep', {
      createId: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', now: () => '2026-08-07T12:00:00.000Z',
    }));
    expect(state.history[0]).toMatchObject({ schemaVersion: 1, itemChanges: [{ before: null }] });
    state = reduceReview(state, { type: 'undo', expectedRevision: state.revision });
    for (const sanitize of [sanitizeChromeReviewRuntimeResponse, sanitizeMacosReviewRuntimeResponse]) {
      const view = sanitize('command', state);
      expect(view).toMatchObject({ items: [], history: { length: 1 }, historyCursor: 0 });
      expect(sanitize('command', view)).toEqual(view);
      expect(JSON.stringify(view)).not.toContain('itemChanges');
    }
    state = reduceReview(state, { type: 'redo', expectedRevision: state.revision });
    expect(state.items[0]?.payload.comment).toBe('Keep');
  });

  it("preserves canonical never-saved revision -1 across shared native hosts", () => {
    const status = { destination: { phase: "none", generation: 0 },
      sync: { phase: "not-saved", desiredRevision: 1, savedRevision: -1 } };
    for (const sanitize of [sanitizeChromeReviewRuntimeResponse, sanitizeMacosReviewRuntimeResponse, sanitizeCodexReviewRuntimeResponse]) {
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
    for (const sanitize of [sanitizeChromeReviewRuntimeRequest, sanitizeMacosReviewRuntimeRequest]) {
      expect(sanitize("exportReviewedCopy", payload)).toEqual(payload);
      for (const fence of [{ expectedRevision: -1, documentGeneration: 1 }, { expectedRevision: 3 },
        { expectedRevision: 3, documentGeneration: 0 }, { ...payload.fence, path: "/private" }]) {
        expect(sanitize("exportReviewedCopy", { fence })).toBeUndefined();
      }
    }
  });
  it("transports only well-shaped document annotation name commands", () => {
    const command = { type: "set-annotation-name", expectedRevision: 2, annotationName: "Brad Ross" };
    expect(sanitizeChromeReviewRuntimeRequest("command", command)).toEqual(command);
    expect(sanitizeChromeReviewRuntimeRequest("command", { ...command, annotationName: 42 })).toBeUndefined();
    expect(sanitizeChromeReviewRuntimeRequest("command", { ...command, preference: true })).toBeUndefined();
  });

  it("transports destination name confirmation and sanitizes its canonical result", () => {
    const confirmation = { command: { type: "set-annotation-name", expectedRevision: 2, annotationName: "Brad Ross" }, expectedGeneration: 1 };
    const state = createReviewState({ sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      source: { fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", digest: "a".repeat(64), byteLength: 100 } });
    const status = { destination: { phase: "none", generation: 0 }, sync: { phase: "clean", desiredRevision: 0, savedRevision: 0 } };
    for (const method of ["chooseCopy", "chooseOriginal"] as const) {
      expect(sanitizeChromeReviewRuntimeRequest(method, { confirmation })).toEqual({ confirmation });
      expect(sanitizeChromeReviewRuntimeRequest(method, { confirmation: { ...confirmation, expectedGeneration: -1 } })).toBeUndefined();
      expect(sanitizeChromeReviewRuntimeRequest(method, { confirmation: { ...confirmation, command: { type: "undo", expectedRevision: 2 } } })).toBeUndefined();
      expect(sanitizeChromeReviewRuntimeRequest(method, { confirmation: { ...confirmation, preference: true } })).toBeUndefined();
      expect(sanitizeChromeReviewRuntimeResponse(method, { ...status, nameResult: state }))
        .toMatchObject({ nameResult: { sessionId: state.sessionId } });
      const unsafe = sanitizeChromeReviewRuntimeResponse(method, { ...status, nameResult: { ...state, credential: "secret" } });
      expect(unsafe === undefined || !JSON.stringify(unsafe).includes("secret")).toBe(true);
      expect(sanitizeChromeReviewRuntimeResponse(method, { ...status, nameResult: { accepted: false, state, message: "Annotation name is too long" } }))
        .toMatchObject({ nameResult: { accepted: false, message: "Annotation name is too long" } });
    }
  });

  it("defines the complete versioned method vocabulary for both hosts", () => {
    expect(REVIEW_RUNTIME_PROTOCOL).toBe("placekeeper.review-runtime");
    expect(REVIEW_RUNTIME_VERSION).toBe(4);
    expect(REVIEW_RUNTIME_METHODS).toEqual([
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
    for (const method of REVIEW_RUNTIME_METHODS) expect(isReviewRuntimeMethod(method)).toBe(true);
    expect(isReviewRuntimeMethod("unknown")).toBe(false);
    expect(isReviewRuntimeMethod(1)).toBe(false);
  });

  it("recognizes opaque review panel keys without accepting arbitrary strings", () => {
    expect(isReviewPanelKey("opaque-panel-key")).toBe(true);
    expect(isReviewPanelKey("short")).toBe(false);
    expect(isReviewPanelKey("unsafe/panel/key")).toBe(false);
    expect(isReviewPanelKey(undefined)).toBe(false);
  });

  it("defines Chrome as a reduced, compiler-visible RPC host", () => {
    expect(REVIEW_RUNTIME_HOSTS).toEqual(["vscode", "chrome", "macos", "codex"]);
    expect(REVIEW_RUNTIME_HOST_METHODS.vscode).toEqual(REVIEW_RUNTIME_METHODS);
    expect(REVIEW_RUNTIME_HOST_METHODS.codex).toEqual(REVIEW_RUNTIME_HOST_METHODS.chrome);
    expect(REVIEW_RUNTIME_HOST_METHODS.chrome).not.toContain("forwardSyncTex");
    expect(REVIEW_RUNTIME_HOST_METHODS.chrome).not.toContain("reverseSyncTex");
    expect(isReviewRuntimeMethodForHost("chrome", "command")).toBe(true);
    expect(isReviewRuntimeMethodForHost("chrome", "reverseSyncTex")).toBe(false);
    expect(REVIEW_RUNTIME_HOST_METHODS.macos).toEqual(REVIEW_RUNTIME_HOST_METHODS.chrome);
    expect(isReviewRuntimeMethodForHost("macos", "command")).toBe(true);
    expect(isReviewRuntimeMethodForHost("macos", "reverseSyncTex")).toBe(false);
  });

  it("projects the Mac runtime without paths, capabilities, or a link base", () => {
    expect(sanitizeMacosReviewRuntimeRequest("command", {
      type: "undo",
      expectedRevision: 0,
    })).toEqual({ type: "undo", expectedRevision: 0 });
    expect(sanitizeMacosReviewRuntimeResponse("scope", {
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
    expect(sanitizeChromeReviewRuntimeRequest("beginInteraction", {
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
    expect(sanitizeChromeReviewRuntimeRequest("beginInteraction", {
      interactionToken: "interaction_token_1234",
      order: 1,
      generation: 1,
      draftId: "unsafe/draft",
    })).toBeUndefined();
    expect(sanitizeChromeReviewRuntimeRequest("chooseCopy", {
      filename: "Reviewed.pdf",
      folderSelectionId: "opaque_folder_selection_1234",
    })).toEqual({ filename: "Reviewed.pdf", folderSelectionId: "opaque_folder_selection_1234" });
    expect(sanitizeChromeReviewRuntimeRequest("chooseCopy", {
      filename: "Reviewed.pdf",
      credential: "secret",
    })).toBeUndefined();
    expect(sanitizeChromeReviewRuntimeRequest("command", {
      type: "undo",
      expectedRevision: 3,
      headers: { authorization: "secret" },
    })).toBeUndefined();
    expect(sanitizeChromeReviewRuntimeRequest("forwardSyncTex", {})).toBeUndefined();
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
    for (const sanitize of [sanitizeChromeReviewRuntimeRequest, sanitizeMacosReviewRuntimeRequest]) {
      expect(sanitize("resolveReadingLocation", request)).toEqual(request);
      expect(sanitize("resolveReadingLocation", {
        ...request,
        anchor: { ...request.anchor, leftContext: "x".repeat(65) },
      })).toBeUndefined();
      expect(sanitize("resolveReadingLocation", { ...request, sessionId: "foreign" })).toBeUndefined();
      expect(sanitize("resolveReadingLocation", { ...request, generation: 0 })).toBeUndefined();
    }
    expect(sanitizeChromeReviewRuntimeResponse("resolveReadingLocation", {
      status: "resolved", generation: 2, pageIndex: 3,
      rect: { x: 20, y: 30, width: 1, height: 8 },
    })).toEqual({
      status: "resolved", generation: 2, pageIndex: 3,
      rect: { x: 20, y: 30, width: 1, height: 8 },
    });
    expect(sanitizeChromeReviewRuntimeResponse("resolveReadingLocation", {
      status: "resolved", generation: 2, pageIndex: 3,
      rect: { x: 20, y: 30, width: 1, height: 8 },
      sourcePath: "/private/paper.pdf",
    })).toBeUndefined();
  });

  it("projects native annotation import state without task, bind, path, credential, or executable authority", () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const state = {
      ...createReviewState({
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
    const projected = sanitizeChromeReviewRuntimeResponse("bootstrap", bootstrap);

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
    const macosProjected = sanitizeMacosReviewRuntimeResponse("bootstrap", {
      ...bootstrap,
      scope: { ...bootstrap.scope, launchSurface: "macos" },
    });
    expect(macosProjected).toMatchObject({
      state: { nativeAnnotationImportDigest: "a".repeat(64), annotationName: "Brad Ross" },
      scope: { documentTitle: "Paper.pdf", launchSurface: "macos" },
      activeAuthoringDraftIds: ["draft_authoring_1234"],
    });
    expect(macosProjected).not.toHaveProperty("canonicalLinkBase");
    expect(sanitizeChromeReviewRuntimeResponse("bootstrap", {
      ...bootstrap,
      activeAuthoringDraftIds: ["draft_authoring_1234", "draft_authoring_1234"],
    })).toBeUndefined();
    const { activeAuthoringDraftIds: _activeAuthoringDraftIds, ...legacyBootstrap } = bootstrap;
    expect(sanitizeChromeReviewRuntimeResponse("bootstrap", legacyBootstrap))
      .toMatchObject({ activeAuthoringDraftIds: [] });
    for (const invalidDigest of [new String("a".repeat(64)), "A".repeat(64), "a".repeat(63)]) {
      expect(sanitizeChromeReviewRuntimeResponse("command", {
        ...state,
        nativeAnnotationImportDigest: invalidDigest,
      })).toBeUndefined();
    }
  });

  it("fails closed on forbidden Chrome response primitives and capability-bearing links", () => {
    expect(sanitizeChromeReviewRuntimeResponse("scope", {
      documentTitle: "Paper.pdf",
      launchSurface: "chrome",
      credential: "secret",
    })).toBeUndefined();
    expect(sanitizeChromeReviewRuntimeResponse("bootstrap", {
      canonicalLinkBase: "placekeeper:///Paper.pdf#credential=secret",
    })).toBeUndefined();
    expect(sanitizeChromeReviewRuntimeResponse("bootstrap", {
      canonicalLinkBase: "placekeeper:///https%3A%2F%2Fexample.com%2Fsecret.pdf",
    })).toBeUndefined();
    expect(sanitizeChromeReviewRuntimeResponse("forwardSyncTex", {})).toBeUndefined();
  });

  it("bounds Chrome-facing titles and removes control and bidirectional overrides", () => {
    expect(sanitizeReviewRuntimeDisplayString("  Quarterly\n\u202eResults  "))
      .toBe("Quarterly Results");
    expect([...sanitizeReviewRuntimeDisplayString("x".repeat(300))!]).toHaveLength(255);
  });

  it("never forwards injected credentials from any Chrome response class", () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const state = createReviewState({
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
      const projected = sanitizeChromeReviewRuntimeResponse(method, value);
      expect(projected === undefined || !JSON.stringify(projected).includes("response-canary"), method)
        .toBe(true);
    }
  });

  it("preserves the remote-temporary save proposal without inventing a local filename", () => {
    expect(sanitizeChromeReviewRuntimeResponse("saveProposal", {
      sourceDisposition: "remote-temporary",
    })).toEqual({ sourceDisposition: "remote-temporary" });
    expect(sanitizeChromeReviewRuntimeResponse("saveProposal", {
      sourceDisposition: "remote-temporary",
      folder: "/private/source",
    })).toBeUndefined();
  });

  it.each(["local", "remote-temporary"])("preserves %s download defaults without exposing the native folder", (sourceDisposition) => {
    expect(sanitizeChromeReviewRuntimeResponse("saveProposal", {
      sourceDisposition, filename: "Original paper.pdf", folder: "/private/custom-downloads",
      folderSelectionId: "download-selection",
    })).toEqual({ sourceDisposition, filename: "Original paper.pdf",
      folder: "Chrome downloads folder", folderSelectionId: "download-selection" });
    expect(sanitizeChromeReviewRuntimeResponse("saveProposal", {
      sourceDisposition, filename: "Original paper.pdf", folder: "/private/custom-downloads",
      folderSelectionId: "../invalid",
    })).toBeUndefined();
  });

  it("fails closed instead of forwarding raw save and export errors", () => {
    expect(sanitizeChromeReviewRuntimeResponse("saveStatus", {
      destination: { phase: "none", generation: 0 },
      sync: {
        phase: "not-saved",
        desiredRevision: 2,
        savedRevision: 1,
        failure: "/Users/reader/private.pdf: EACCES",
      },
    })).toBeUndefined();
    expect(sanitizeChromeReviewRuntimeResponse("exportReviewedCopy", {
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
  expect(sanitizeCodexReviewRuntimeResponse('scope', scope)).toMatchObject({ launchSurface: 'codex', codexContext: scope.codexContext });
  for (const codexContext of [{ ...scope.codexContext, taskId: 'private' }, { ...scope.codexContext, identity: { ...identity, path: '/private/review.pdf' } }, { ...scope.codexContext, identity: { ...identity, stateDigest: 'wrong' } }]) {
    expect(sanitizeCodexReviewRuntimeResponse('scope', { ...scope, codexContext })).toBeUndefined();
  }
});
