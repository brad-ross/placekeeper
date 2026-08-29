import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import * as vscode from "vscode";

import {
  ScopedExternalLaunchRegistrations,
  parseScopedExternalLaunchUri,
} from "./external-launch-registration.js";
import {
  createPrivateSnapshotDirectory,
  exchangeVscodeLaunch,
  markLiveDocumentPossiblyStale,
  materializePrivatePdfSnapshot,
  observeLiveDocument,
  runLaunchClient,
} from "./launch-client.js";
import {
  containedSourcePath,
  isLatexSourcePath,
  isPathInside,
  sidecarWatchPattern,
} from "./latex-project.js";
import {
  LATEX_WORKSHOP_OWNED_SETTINGS,
  compatibilityPrior,
  compatibilityStatus,
  previewCompatibilitySetup,
  restoreCompatibilitySettings,
  type CompatibilitySetupRecord,
  type WorkspaceSettingValues,
} from "./latex-workshop-bridge.js";
import {
  INPUT_UNAVAILABLE,
  choosePdfUriInput,
  classifyWorkspace,
  resolveLauncherPath,
  resolveExternalLauncherPath,
  resolveSourceOutputBinding,
  selectedUriArguments,
  tabResourceUri,
  type LaunchErrorPresentation,
  type UriLike,
} from "./local-workspace.js";
import { RebuildObserver } from "./rebuild-observer.js";
import { ReviewPanelController, type ReviewBinding } from "./review-panel-controller.js";
import { buildReviewWebviewHtml, parseSharedAssetManifest, reviewPanelOptions } from "./review-panel.js";
import { openSourceEditor, sourceLineNumber, sourceLineReveal } from "./source-navigation.js";
import {
  WEBVIEW_RPC_PROTOCOL,
  WEBVIEW_RPC_VERSION,
  VersionedWebviewBridge,
  createLoopbackRuntimeClient,
  forwardSyncTexRetryable,
  forwardSyncTexStatus,
  forwardSyncTexTarget,
  type ForwardSyncTexStatus,
  type TrustedRuntimeClient,
} from "./webview-bridge.js";

const VIEW_COMMANDS = ["placekeeper.open", "placekeeper.viewPdf"] as const;
const PANEL_TYPE = "placekeeper.review";
const PANEL_BINDINGS_KEY = "placekeeper.panel-bindings.v1";
const COMPATIBILITY_SETUP_KEY = "placekeeper.latex-workshop-setup.v1";
const REVALIDATE_INTERVAL_MS = 30_000;
const SOURCE_HIGHLIGHT_MS = 2_000;

interface SourceHighlightState {
  readonly decoration: vscode.TextEditorDecorationType;
  readonly timers: Map<vscode.TextEditor, ReturnType<typeof setTimeout>>;
}

type PanelAttachStage = "launch" | "exchange" | "storage" | "assets" | "runtime" | "webview";

class PresentedLaunchError extends Error {
  constructor(readonly presentation: LaunchErrorPresentation) {
    super("Placekeeper launch was rejected");
  }
}

class PanelAttachError extends Error {
  constructor(readonly stage: PanelAttachStage, readonly safeReason?: string) {
    super(`Placekeeper embedded panel failed during ${stage}`);
  }
}

function safeAttachReason(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const allowed = [
    "Only extension-issued webview resources are allowed",
    "Only the webview CSP source is allowed",
    "A safe nonce is required",
    "A safe panel identity is required",
    "A safe panel key is required",
  ];
  return allowed.includes(error.message) ? error.message : undefined;
}

async function attachStage<T>(
  stage: PanelAttachStage,
  operation: () => T | Promise<T>,
): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof PresentedLaunchError || error instanceof PanelAttachError) throw error;
    throw new PanelAttachError(stage, safeAttachReason(error));
  }
}

interface PanelRuntime {
  readonly binding: ReviewBinding;
  readonly client: TrustedRuntimeClient;
  readonly registrationId: string;
  flushTimer?: ReturnType<typeof setTimeout>;
}

function workspaceError(): LaunchErrorPresentation | undefined {
  return classifyWorkspace({
    ...(vscode.env.remoteName === undefined ? {} : { remoteName: vscode.env.remoteName }),
    uiKind: vscode.env.uiKind === vscode.UIKind.Desktop ? "desktop" : "web",
    workspaceSchemes: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.scheme),
  });
}

async function showSharedError(error: LaunchErrorPresentation): Promise<void> {
  const selected = await vscode.window.showErrorMessage(error.message, error.recoveryAction);
  if (selected === error.recoveryAction && error.kind === "unsupported-context") {
    await vscode.commands.executeCommand("workbench.action.newWindow");
  }
  if (selected === error.recoveryAction && error.kind === "input-unavailable") {
    const chosen = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      filters: { PDF: ["pdf"] },
    });
    if (chosen?.[0] !== undefined) await vscode.commands.executeCommand("placekeeper.viewPdf", chosen[0]);
  }
}

async function chooseBinding(commandArgs: readonly unknown[]): Promise<ReviewBinding | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri ??
    tabResourceUri(vscode.window.tabGroups.activeTabGroup.activeTab?.input);
  const selected = selectedUriArguments(commandArgs[0], commandArgs[1]);
  const direct = choosePdfUriInput({
    ...(active === undefined ? {} : { active }),
    selected,
  });
  let chosen: UriLike | undefined = "scheme" in direct ? direct : undefined;
  if (chosen === undefined && active?.scheme === "file" && isLatexSourcePath(active.fsPath)) {
    const candidates = await vscode.workspace.findFiles("**/*.pdf", "**/{.git,node_modules}/**", 64);
    const binding = resolveSourceOutputBinding({ activeSource: active, candidates });
    if (binding.kind === "bound") chosen = binding.uri;
    if (binding.kind === "choose") {
      const labels = binding.candidates.map((candidate) => candidate.fsPath);
      const selectedLabel = await vscode.window.showQuickPick(labels, {
        title: "Choose generated PDF",
        placeHolder: "Placekeeper will keep this output bound to its own review tab",
      });
      chosen = binding.candidates.find((candidate) => candidate.fsPath === selectedLabel);
    }
  }
  if (chosen === undefined) {
    await showSharedError(INPUT_UNAVAILABLE);
    return undefined;
  }
  return {
    outputPath: chosen.fsPath,
    ...(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(chosen.fsPath))?.uri.fsPath === undefined
      ? {}
      : { sourceRoot: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(chosen.fsPath))!.uri.fsPath }),
  };
}

function sourceLocation(binding: ReviewBinding): {
  readonly sourcePath: string;
  readonly line: number;
  readonly column: number;
} | undefined {
  if (!vscode.workspace.isTrusted) return undefined;
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.uri.scheme !== "file" || !isLatexSourcePath(editor.document.uri.fsPath) ||
    (binding.sourceRoot !== undefined && !isPathInside(binding.sourceRoot, editor.document.uri.fsPath))) return undefined;
  return {
    sourcePath: editor.document.uri.fsPath,
    line: editor.selection.active.line + 1,
    column: editor.selection.active.character + 1,
  };
}

async function openSourceLocation(
  binding: ReviewBinding,
  location: { readonly sourcePath: string; readonly line: number; readonly column?: number },
  highlight: SourceHighlightState,
  avoidViewColumn?: number,
): Promise<void> {
  const sourcePath = binding.sourceRoot === undefined
    ? undefined
    : containedSourcePath(binding.sourceRoot, location.sourcePath);
  if (!vscode.workspace.isTrusted || sourcePath === undefined) {
    throw new Error("Source navigation is unavailable in this workspace");
  }
  const sourceUri = vscode.Uri.file(sourcePath);
  const editor = await openSourceEditor({
    sourceUri,
    visibleEditors: vscode.window.visibleTextEditors,
    tabGroups: vscode.window.tabGroups.all,
    ...(avoidViewColumn === undefined ? {} : { avoidViewColumn }),
    tabResourceUri,
    openTextDocument: () => vscode.workspace.openTextDocument(sourceUri),
    showTextDocument: (document, options) => vscode.window.showTextDocument(document, options),
  });
  const lineNumber = sourceLineNumber(editor.document.lineCount, location.line);
  if (lineNumber === undefined) {
    void vscode.window.showWarningMessage(
      "This SyncTeX location no longer matches the current source. Rebuild the PDF and try again.",
    );
    return;
  }
  const line = editor.document.lineAt(lineNumber);
  const reveal = sourceLineReveal(line.text, location.column);
  if (reveal === undefined) {
    void vscode.window.showWarningMessage(
      "This SyncTeX location no longer matches the current source. Rebuild the PDF and try again.",
    );
    return;
  }
  const position = new vscode.Position(lineNumber, reveal.character);
  const highlightRange = new vscode.Range(
    new vscode.Position(lineNumber, reveal.highlightStart),
    new vscode.Position(lineNumber, reveal.highlightEnd),
  );
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(highlightRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  const existingTimer = highlight.timers.get(editor);
  if (existingTimer !== undefined) clearTimeout(existingTimer);
  editor.setDecorations(highlight.decoration, [highlightRange]);
  highlight.timers.set(editor, setTimeout(() => {
    editor.setDecorations(highlight.decoration, []);
    highlight.timers.delete(editor);
  }, SOURCE_HIGHLIGHT_MS));
}

async function revealForwardSyncTexTarget(
  panel: vscode.WebviewPanel,
  runtime: PanelRuntime,
): Promise<ForwardSyncTexStatus> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await runtime.client.invoke("forwardSyncTex", {}, new AbortController().signal);
    const target = forwardSyncTexTarget(result);
    if (target !== undefined) {
      await panel.webview.postMessage({
        protocol: WEBVIEW_RPC_PROTOCOL,
        version: WEBVIEW_RPC_VERSION,
        kind: "event",
        event: "host-command",
        panelId: runtime.client.identity.panelId,
        payload: { command: "forward-synctex", ...target },
      });
      return "ok";
    }
    const status = forwardSyncTexStatus(result) ?? "failed";
    if (!forwardSyncTexRetryable(result) || attempt === 5) return status;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return "failed";
}

export function activate(context: vscode.ExtensionContext): void {
  const runtimes = new WeakMap<vscode.WebviewPanel, PanelRuntime>();
  const registrations = new ScopedExternalLaunchRegistrations();
  const sourceHighlight: SourceHighlightState = {
    decoration: vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
      borderRadius: "2px",
    }),
    timers: new Map(),
  };
  context.subscriptions.push({
    dispose: () => {
      for (const timer of sourceHighlight.timers.values()) clearTimeout(timer);
      sourceHighlight.timers.clear();
      sourceHighlight.decoration.dispose();
    },
  });
  const windowId = randomBytes(18).toString("base64url");
  let activePanel: vscode.WebviewPanel | undefined;

  const panelBindings = (): Record<string, ReviewBinding> =>
    context.globalState.get<Record<string, ReviewBinding>>(PANEL_BINDINGS_KEY) ?? {};

  const persistPanelBinding = async (panelKey: string, binding: ReviewBinding): Promise<void> => {
    await context.globalState.update(PANEL_BINDINGS_KEY, { ...panelBindings(), [panelKey]: binding });
  };

  const attachPanel = async (
    panel: vscode.WebviewPanel,
    binding: ReviewBinding,
    panelKey = randomBytes(18).toString("base64url"),
  ): Promise<void> => {
    let panelDisposed = false;
    const earlyDispose = panel.onDidDispose(() => { panelDisposed = true; });
    const requireOpenPanel = (): void => {
      if (panelDisposed) throw new Error("The Placekeeper panel was closed during attachment");
    };
    const error = workspaceError();
    if (error !== undefined) throw new Error(error.message);
    const configured = vscode.workspace.getConfiguration("placekeeper").get<string>("launcherPath");
    const executable = resolveLauncherPath(configured, homedir());
    let launched = await attachStage("launch", () =>
      runLaunchClient(executable, binding.outputPath, binding.sourceRoot, undefined, undefined, "generated-output"));
    requireOpenPanel();
    while (launched.ok && launched.kind === "recovery-offered") {
      const recoveryLaunch = launched;
      const decision = await vscode.window.showQuickPick(recoveryLaunch.choices, {
        title: "Recover Placekeeper draft",
        placeHolder: "Resume, discard, or start an independent review",
      });
      if (decision !== "resume" && decision !== "discard" && decision !== "fork") throw new Error("Recovery was cancelled");
      launched = await attachStage("launch", () => runLaunchClient(executable, binding.outputPath, binding.sourceRoot, undefined, {
        decision,
        offer: recoveryLaunch.recoveryOffer,
        operationId: randomBytes(18).toString("base64url"),
      }, "generated-output"));
      requireOpenPanel();
    }
    if (!launched.ok) throw new PresentedLaunchError(launched.error);
    const exchanged = await attachStage("exchange", () => exchangeVscodeLaunch(launched.url));
    requireOpenPanel();
    const snapshotRoot = await attachStage("storage", () =>
      createPrivateSnapshotDirectory(context.globalStorageUri.fsPath));
    if (panelDisposed) {
      await rm(snapshotRoot, { recursive: true, force: true });
      requireOpenPanel();
    }
    const installedWebRoot = context.asAbsolutePath("dist/web");
    const developmentWebRoot = resolve(context.asAbsolutePath("."), "../../dist/web");
    const webRoot = existsSync(installedWebRoot) ? installedWebRoot : developmentWebRoot;
    const assetManifest = await attachStage("assets", async () => parseSharedAssetManifest(JSON.parse(
      await readFile(resolve(webRoot, "asset-manifest.json"), "utf8"),
    ) as unknown));
    if (panelDisposed) {
      await rm(snapshotRoot, { recursive: true, force: true });
      requireOpenPanel();
    }
    const webRootUri = vscode.Uri.file(webRoot);
    const snapshotRootUri = vscode.Uri.file(snapshotRoot);
    panel.webview.options = reviewPanelOptions([webRootUri, snapshotRootUri]);
    const resourceUri = (name: string) => panel.webview.asWebviewUri(vscode.Uri.file(resolve(webRoot, name))).toString();
    const panelId = randomBytes(18).toString("base64url");
    let runtime: PanelRuntime;
    const client = await attachStage("runtime", () => createLoopbackRuntimeClient({
      panelId,
      launch: exchanged,
      assets: { pdfiumWasm: resourceUri(assetManifest.pdfiumWasm) },
      materializeDocument: async ({ bytes, digest, byteLength }) => {
        const path = await materializePrivatePdfSnapshot({ directory: snapshotRoot, bytes, digest, byteLength });
        return panel.webview.asWebviewUri(vscode.Uri.file(path)).toString();
      },
      forwardSourceLocation: () => sourceLocation(binding),
      sourceNavigationAllowed: () => vscode.workspace.isTrusted,
      openSourceLocation: async (location) =>
        openSourceLocation(binding, location, sourceHighlight, panel.viewColumn),
    }));
    if (panelDisposed) {
      client.dispose();
      await rm(snapshotRoot, { recursive: true, force: true });
      requireOpenPanel();
    }
    const bridge = new VersionedWebviewBridge(client, (message) => panel.webview.postMessage(message));
    const observer = new RebuildObserver({
      outputPath: binding.outputPath,
      initialEpoch: Date.now() * 1_000,
      validate: ({ outputPath, observationEpoch }) => observeLiveDocument(exchanged, { outputPath, observationEpoch }),
      markPossiblyStale: ({ observationEpoch }) =>
        markLiveDocumentPossiblyStale(exchanged, { observationEpoch }).then(() => undefined),
      onCurrentResult: (result) => {
        if (typeof result === "object" && result !== null && (result as { status?: unknown }).status === "committed") {
          observer.noteCurrent();
        }
      },
    });
    const registrationId = randomBytes(18).toString("base64url");
    registrations.register({ registrationId, canonicalOutputPath: binding.outputPath, windowId });
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dirname(binding.outputPath), sidecarWatchPattern(binding.outputPath)),
    );
    const scheduleFlush = (): void => {
      if (runtime.flushTimer !== undefined) clearTimeout(runtime.flushTimer);
      runtime.flushTimer = setTimeout(() => { void observer.flush(); }, 250);
    };
    const disposables: vscode.Disposable[] = [
      watcher,
      watcher.onDidCreate((uri) => { observer.noteFileEvent(uri.fsPath); scheduleFlush(); }),
      watcher.onDidChange((uri) => { observer.noteFileEvent(uri.fsPath); scheduleFlush(); }),
      watcher.onDidDelete((uri) => { observer.noteFileEvent(uri.fsPath); scheduleFlush(); }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme === "file" && binding.sourceRoot !== undefined &&
          isLatexSourcePath(document.uri.fsPath) && isPathInside(binding.sourceRoot, document.uri.fsPath)) {
          void observer.noteSourceSaved();
        }
      }),
      panel.webview.onDidReceiveMessage((message) => bridge.receive(message)),
      panel.onDidChangeViewState(({ webviewPanel }) => {
        if (webviewPanel.active) void observer.revalidate("activation");
        else if (webviewPanel.visible) void observer.revalidate("reveal");
        if (webviewPanel.active) activePanel = webviewPanel;
      }),
    ];
    const interval = setInterval(() => { void observer.tick(); }, REVALIDATE_INTERVAL_MS);
    interval.unref?.();
    disposables.push({ dispose: () => clearInterval(interval) });
    runtime = { binding, client, registrationId };
    runtimes.set(panel, runtime);
    activePanel = panel;
    earlyDispose.dispose();
    panel.onDidDispose(() => {
      observer.dispose();
      bridge.dispose();
      if (runtime.flushTimer !== undefined) clearTimeout(runtime.flushTimer);
      for (const disposable of disposables) disposable.dispose();
      registrations.unregister(registrationId);
      if (activePanel === panel) activePanel = undefined;
      void rm(snapshotRoot, { recursive: true, force: true });
    });
    await attachStage("webview", () => {
      panel.webview.html = buildReviewWebviewHtml({
        nonce: randomBytes(18).toString("base64url"),
        panelId,
        panelKey,
        scriptUri: resourceUri(assetManifest.app),
        styleUri: resourceUri(assetManifest.stylesheet),
        cspSource: panel.webview.cspSource,
      });
    });
    await persistPanelBinding(panelKey, binding);
  };

  const controller = new ReviewPanelController<vscode.WebviewPanel>({
    canonicalize: async (path) => realpath(path),
    create: async (binding) => {
      const panel = vscode.window.createWebviewPanel(
        PANEL_TYPE,
        `Placekeeper — ${basename(binding.outputPath)}`,
        vscode.ViewColumn.Beside,
        reviewPanelOptions([]),
      );
      try { await attachPanel(panel, binding); }
      catch (error) {
        panel.dispose();
        throw error;
      }
      return panel;
    },
    detach: () => undefined,
    resolvePanelKey: async (panelKey) => panelBindings()[panelKey],
    attachRestored: async (panel, binding) => {
      const state = panelBindings();
      const panelKey = Object.entries(state).find(([, value]) => value.outputPath === binding.outputPath)?.[0];
      if (panelKey === undefined) throw new Error("Restored panel binding is unavailable");
      await attachPanel(panel, binding, panelKey);
    },
  });

  const openPanel = async (
    binding: ReviewBinding,
    revealExisting: boolean,
  ): Promise<vscode.WebviewPanel | undefined> => {
    try {
      if (!revealExisting) {
        const existing = await controller.panelFor(binding.outputPath);
        if (existing !== undefined) return existing;
      }
      return await controller.open(binding);
    }
    catch (error) {
      if (error instanceof PresentedLaunchError) await showSharedError(error.presentation);
      else {
        const stage = error instanceof PanelAttachError ? error.stage : "unknown";
        const reason = error instanceof PanelAttachError && error.safeReason !== undefined
          ? `: ${error.safeReason}`
          : "";
        console.error(`[Placekeeper] embedded panel attach failed during ${stage}${reason}`);
        await showSharedError(INPUT_UNAVAILABLE);
      }
      return undefined;
    }
  };

  const view = async (...args: unknown[]): Promise<vscode.WebviewPanel | undefined> => {
    const error = workspaceError();
    if (error !== undefined) { await showSharedError(error); return undefined; }
    const binding = await chooseBinding(args);
    if (binding === undefined) return undefined;
    return openPanel(binding, true);
  };

  for (const command of VIEW_COMMANDS) context.subscriptions.push(vscode.commands.registerCommand(command, view));
  context.subscriptions.push(
    vscode.commands.registerCommand("placekeeper.forwardSyncTex", async (...args: unknown[]) => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage("Trust this workspace to run SyncTeX.");
        return false;
      }
      const error = workspaceError();
      if (error !== undefined) { await showSharedError(error); return false; }
      const binding = await chooseBinding(args);
      if (binding === undefined) return false;
      // Reuse without revealing first: revealing activates rebuild validation,
      // which must not queue ahead of a source-to-PDF navigation request.
      const panel = await openPanel(binding, false);
      const runtime = panel === undefined ? undefined : runtimes.get(panel);
      if (panel === undefined || runtime === undefined) return false;
      try {
        const status = await revealForwardSyncTexTarget(panel, runtime);
        if (status !== "ok") {
          void vscode.window.showWarningMessage("Forward SyncTeX could not find this source location. PDF review remains available.");
          return status;
        }
        panel.reveal(panel.viewColumn, false);
        activePanel = panel;
        return status;
      }
      catch {
        void vscode.window.showWarningMessage("Forward SyncTeX is unavailable. PDF review remains available.");
        return "failed";
      }
    }),
    vscode.commands.registerCommand("placekeeper.goToSource", async () => {
      const runtime = activePanel === undefined ? undefined : runtimes.get(activePanel);
      if (!vscode.workspace.isTrusted) { await vscode.window.showWarningMessage("Trust this workspace to open LaTeX source."); return; }
      if (activePanel === undefined || runtime === undefined) {
        await vscode.window.showInformationMessage("Open a generated PDF in Placekeeper first.");
        return;
      }
      await activePanel.webview.postMessage({
        protocol: WEBVIEW_RPC_PROTOCOL,
        version: WEBVIEW_RPC_VERSION,
        kind: "event",
        event: "host-command",
        panelId: runtime.client.identity.panelId,
        payload: { command: "reverse-synctex" },
      });
    }),
    vscode.commands.registerCommand("placekeeper.reattach", async () => {
      if (activePanel === undefined) return;
      const runtime = runtimes.get(activePanel);
      if (runtime === undefined) return;
      await activePanel.webview.postMessage({
        protocol: WEBVIEW_RPC_PROTOCOL,
        version: WEBVIEW_RPC_VERSION,
        kind: "event",
        event: "host-command",
        panelId: runtime.client.identity.panelId,
        payload: { command: "reattach" },
      });
    }),
    vscode.commands.registerCommand("placekeeper.exportReviewedPdf", async () => {
      const runtime = activePanel === undefined ? undefined : runtimes.get(activePanel);
      if (runtime === undefined) return;
      try { await runtime.client.invoke("exportReviewedCopy", {}, new AbortController().signal); }
      catch { await vscode.window.showWarningMessage("Export is blocked until unresolved review work is reconciled."); }
    }),
    vscode.commands.registerCommand("placekeeper.configureLatexWorkshop", async () => {
      if (!vscode.workspace.isTrusted) { await vscode.window.showWarningMessage("Trust this workspace before changing LaTeX Workshop settings."); return; }
      const runtime = activePanel === undefined ? undefined : runtimes.get(activePanel);
      if (runtime === undefined) { await vscode.window.showInformationMessage("Open a generated PDF in Placekeeper first."); return; }
      const extension = vscode.extensions.getExtension("James-Yu.latex-workshop");
      const status = compatibilityStatus(extension?.packageJSON.version);
      if (status.status !== "available") {
        await vscode.window.showWarningMessage(`LaTeX Workshop compatibility is ${status.status}. Placekeeper View PDF and Forward SyncTeX remain available.`);
        return;
      }
      const configuration = vscode.workspace.getConfiguration();
      const current = Object.fromEntries(LATEX_WORKSHOP_OWNED_SETTINGS.map((key) => [
        key, configuration.inspect(key)?.workspaceValue,
      ])) as unknown as WorkspaceSettingValues;
      const prior = compatibilityPrior(
        current,
        context.workspaceState.get<CompatibilitySetupRecord>(COMPATIBILITY_SETUP_KEY),
      );
      const launcher = resolveExternalLauncherPath(
        vscode.workspace.getConfiguration("placekeeper").get<string>("externalLauncherPath"),
        homedir(),
      );
      if (!existsSync(launcher)) {
        await vscode.window.showWarningMessage("The scoped LaTeX Workshop compatibility launcher is not installed. Placekeeper View PDF and Forward SyncTeX remain available.");
        return;
      }
      const setup = previewCompatibilitySetup(prior, { command: launcher, registrationId: runtime.registrationId });
      const selected = await vscode.window.showWarningMessage(
        `Preview workspace changes:\n${JSON.stringify(setup.next, null, 2)}\nPlacekeeper will restore only values it still owns.`,
        "Apply",
      );
      if (selected !== "Apply") return;
      for (const key of LATEX_WORKSHOP_OWNED_SETTINGS) {
        await configuration.update(key, setup.next[key], vscode.ConfigurationTarget.Workspace);
      }
      await context.workspaceState.update(COMPATIBILITY_SETUP_KEY, setup);
    }),
    vscode.commands.registerCommand("placekeeper.restoreLatexWorkshop", async () => {
      if (!vscode.workspace.isTrusted) { await vscode.window.showWarningMessage("Trust this workspace before changing LaTeX Workshop settings."); return; }
      const setup = context.workspaceState.get<CompatibilitySetupRecord>(COMPATIBILITY_SETUP_KEY);
      if (setup === undefined) return;
      const configuration = vscode.workspace.getConfiguration();
      const current = Object.fromEntries(LATEX_WORKSHOP_OWNED_SETTINGS.map((key) => [
        key, configuration.inspect(key)?.workspaceValue,
      ])) as unknown as WorkspaceSettingValues;
      const restore = restoreCompatibilitySettings(current, setup);
      for (const [key, value] of Object.entries(restore)) {
        await configuration.update(key, value, vscode.ConfigurationTarget.Workspace);
      }
      await context.workspaceState.update(COMPATIBILITY_SETUP_KEY, undefined);
    }),
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        try {
          const route = parseScopedExternalLaunchUri(uri);
          const registration = registrations.resolve(route);
          const panel = await controller.panelFor(registration.canonicalOutputPath);
          const runtime = panel === undefined ? undefined : runtimes.get(panel);
          if (panel === undefined || runtime === undefined) throw new Error("The scoped panel registration is stale");
          panel.reveal(panel.viewColumn, false);
          activePanel = panel;
          if (sourceLocation(runtime.binding) !== undefined) {
            if (await revealForwardSyncTexTarget(panel, runtime) !== "ok") {
              throw new Error("Forward SyncTeX did not return a target");
            }
          }
        } catch {
          await vscode.window.showWarningMessage(
            "The scoped LaTeX Workshop route is unavailable. Use Placekeeper: View PDF or Placekeeper: Forward SyncTeX.",
          );
        }
      },
    }),
    vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, {
      async deserializeWebviewPanel(panel, state) {
        const restored = await controller.restore(panel, state);
        if (restored.status === "retry") {
          panel.webview.html = "<!doctype html><html><body><main><h1>Placekeeper review needs reattachment</h1><p>The saved output or service is unavailable.</p></main></body></html>";
        }
      },
    }),
  );
}

export function deactivate(): void {}
