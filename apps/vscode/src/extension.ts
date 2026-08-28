import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import * as vscode from "vscode";

import { ScopedExternalLaunchRegistrations } from "./external-launch-registration.js";
import {
  createPrivateSnapshotDirectory,
  exchangeVscodeLaunch,
  markLiveDocumentPossiblyStale,
  materializePrivatePdfSnapshot,
  observeLiveDocument,
  runLaunchClient,
} from "./launch-client.js";
import {
  isLatexSourcePath,
  isPathInside,
  sidecarWatchPattern,
} from "./latex-project.js";
import {
  LATEX_WORKSHOP_OWNED_SETTINGS,
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
  resolveSourceOutputBinding,
  type LaunchErrorPresentation,
  type UriLike,
} from "./local-workspace.js";
import { RebuildObserver } from "./rebuild-observer.js";
import { ReviewPanelController, type ReviewBinding } from "./review-panel-controller.js";
import { buildReviewWebviewHtml, parseSharedAssetManifest, reviewPanelOptions } from "./review-panel.js";
import {
  VersionedWebviewBridge,
  createLoopbackRuntimeClient,
  type TrustedRuntimeClient,
} from "./webview-bridge.js";

const VIEW_COMMANDS = ["placekeeper.open", "placekeeper.viewPdf"] as const;
const PANEL_TYPE = "placekeeper.review";
const PANEL_BINDINGS_KEY = "placekeeper.panel-bindings.v1";
const COMPATIBILITY_SETUP_KEY = "placekeeper.latex-workshop-setup.v1";
const REVALIDATE_INTERVAL_MS = 30_000;

interface PanelRuntime {
  readonly binding: ReviewBinding;
  readonly panelKey: string;
  readonly client: TrustedRuntimeClient;
  readonly observer: RebuildObserver<unknown>;
  readonly registrationId: string;
  readonly disposables: vscode.Disposable[];
  readonly snapshotRoot: string;
  flushTimer?: ReturnType<typeof setTimeout>;
  lastSourceLocation?: { readonly sourcePath: string; readonly line: number; readonly column?: number };
}

function selectedUris(first: unknown, many: unknown): UriLike[] {
  if (Array.isArray(many)) return many as UriLike[];
  if (typeof first === "object" && first !== null) return [first as UriLike];
  return [];
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
  const active = vscode.window.activeTextEditor?.document.uri;
  const selected = selectedUris(commandArgs[0], commandArgs[1]);
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
): Promise<void> {
  if (!vscode.workspace.isTrusted || binding.sourceRoot === undefined ||
    !isPathInside(binding.sourceRoot, location.sourcePath)) {
    throw new Error("Source navigation is unavailable in this workspace");
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(location.sourcePath));
  const editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
  const position = new vscode.Position(Math.max(0, location.line - 1), Math.max(0, (location.column ?? 1) - 1));
  editor.revealRange(new vscode.Range(position, position));
}

export function activate(context: vscode.ExtensionContext): void {
  const runtimes = new WeakMap<vscode.WebviewPanel, PanelRuntime>();
  const registrations = new ScopedExternalLaunchRegistrations();
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
    const error = workspaceError();
    if (error !== undefined) throw new Error(error.message);
    const configured = vscode.workspace.getConfiguration("placekeeper").get<string>("launcherPath");
    const executable = resolveLauncherPath(configured, homedir());
    let launched = await runLaunchClient(executable, binding.outputPath, binding.sourceRoot, undefined, undefined, "generated-output");
    while (launched.ok && launched.kind === "recovery-offered") {
      const decision = await vscode.window.showQuickPick(launched.choices, {
        title: "Recover Placekeeper draft",
        placeHolder: "Resume, discard, or start an independent review",
      });
      if (decision !== "resume" && decision !== "discard" && decision !== "fork") throw new Error("Recovery was cancelled");
      launched = await runLaunchClient(executable, binding.outputPath, binding.sourceRoot, undefined, {
        decision,
        offer: launched.recoveryOffer,
        operationId: randomBytes(18).toString("base64url"),
      }, "generated-output");
    }
    if (!launched.ok) throw new Error(launched.error.message);
    const exchanged = await exchangeVscodeLaunch(launched.url);
    const snapshotRoot = await createPrivateSnapshotDirectory(context.globalStorageUri.fsPath);
    const installedWebRoot = context.asAbsolutePath("dist/web");
    const developmentWebRoot = resolve(context.asAbsolutePath("."), "../../dist/web");
    const webRoot = existsSync(installedWebRoot) ? installedWebRoot : developmentWebRoot;
    const assetManifest = parseSharedAssetManifest(JSON.parse(
      await readFile(resolve(webRoot, "asset-manifest.json"), "utf8"),
    ) as unknown);
    const webRootUri = vscode.Uri.file(webRoot);
    const snapshotRootUri = vscode.Uri.file(snapshotRoot);
    panel.webview.options = reviewPanelOptions([webRootUri, snapshotRootUri]);
    const resourceUri = (name: string) => panel.webview.asWebviewUri(vscode.Uri.file(resolve(webRoot, name))).toString();
    const panelId = randomBytes(18).toString("base64url");
    let runtime: PanelRuntime;
    const client = createLoopbackRuntimeClient({
      panelId,
      launch: exchanged,
      assets: { pdfiumWasm: resourceUri(assetManifest.pdfiumWasm) },
      materializeDocument: async ({ bytes, digest, byteLength }) => {
        const path = await materializePrivatePdfSnapshot({ directory: snapshotRoot, bytes, digest, byteLength });
        return panel.webview.asWebviewUri(vscode.Uri.file(path)).toString();
      },
      forwardSourceLocation: () => sourceLocation(binding),
      openSourceLocation: async (location) => {
        runtime.lastSourceLocation = location;
        await openSourceLocation(binding, location);
      },
    });
    const bridge = new VersionedWebviewBridge(client, (message) => panel.webview.postMessage(message));
    const observer = new RebuildObserver({
      outputPath: binding.outputPath,
      initialEpoch: Date.now() * 1_000,
      validate: ({ outputPath, observationEpoch }) => observeLiveDocument(exchanged, { outputPath, observationEpoch }),
      markPossiblyStale: () => markLiveDocumentPossiblyStale(exchanged).then(() => undefined),
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
      watcher.onDidCreate((uri) => { observer.noteFileEvent("create", uri.fsPath); scheduleFlush(); }),
      watcher.onDidChange((uri) => { observer.noteFileEvent("change", uri.fsPath); scheduleFlush(); }),
      watcher.onDidDelete((uri) => { observer.noteFileEvent("delete", uri.fsPath); scheduleFlush(); }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme === "file" && binding.sourceRoot !== undefined &&
          isLatexSourcePath(document.uri.fsPath) && isPathInside(binding.sourceRoot, document.uri.fsPath)) {
          void observer.noteSourceSaved(document.uri.fsPath);
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
    runtime = { binding, panelKey, client, observer, registrationId, disposables, snapshotRoot };
    runtimes.set(panel, runtime);
    activePanel = panel;
    panel.onDidDispose(() => {
      observer.dispose();
      bridge.dispose();
      if (runtime.flushTimer !== undefined) clearTimeout(runtime.flushTimer);
      for (const disposable of disposables) disposable.dispose();
      registrations.unregister(registrationId);
      if (activePanel === panel) activePanel = undefined;
      void rm(snapshotRoot, { recursive: true, force: true });
    });
    panel.webview.html = buildReviewWebviewHtml({
      nonce: randomBytes(18).toString("base64url"),
      panelId,
      panelKey,
      scriptUri: resourceUri(assetManifest.app),
      styleUri: resourceUri(assetManifest.stylesheet),
      cspSource: panel.webview.cspSource,
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

  const view = async (...args: unknown[]): Promise<vscode.WebviewPanel | undefined> => {
    const error = workspaceError();
    if (error !== undefined) { await showSharedError(error); return undefined; }
    const binding = await chooseBinding(args);
    if (binding === undefined) return undefined;
    try {
      const panel = await controller.open(binding);
      await runtimes.get(panel)?.observer.revalidate("reveal");
      return panel;
    }
    catch { await showSharedError(INPUT_UNAVAILABLE); return undefined; }
  };

  for (const command of VIEW_COMMANDS) context.subscriptions.push(vscode.commands.registerCommand(command, view));
  context.subscriptions.push(
    vscode.commands.registerCommand("placekeeper.forwardSyncTex", async (...args: unknown[]) => {
      if (!vscode.workspace.isTrusted) { await vscode.window.showWarningMessage("Trust this workspace to run SyncTeX."); return; }
      const panel = await view(...args);
      const runtime = panel === undefined ? undefined : runtimes.get(panel);
      if (runtime === undefined) return;
      try { await runtime.client.invoke("forwardSyncTex", {}, new AbortController().signal); }
      catch { await vscode.window.showWarningMessage("Forward SyncTeX is unavailable. PDF review remains available."); }
    }),
    vscode.commands.registerCommand("placekeeper.goToSource", async () => {
      const runtime = activePanel === undefined ? undefined : runtimes.get(activePanel);
      if (!vscode.workspace.isTrusted) { await vscode.window.showWarningMessage("Trust this workspace to open LaTeX source."); return; }
      if (runtime?.lastSourceLocation === undefined) {
        await vscode.window.showInformationMessage("Choose Go to Source from a PDF location first.");
        return;
      }
      await openSourceLocation(runtime.binding, runtime.lastSourceLocation);
    }),
    vscode.commands.registerCommand("placekeeper.reattach", async () => {
      if (activePanel === undefined) return;
      await activePanel.webview.postMessage({ kind: "host-command", command: "reattach" });
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
      const prior = Object.fromEntries(LATEX_WORKSHOP_OWNED_SETTINGS.map((key) => [
        key, configuration.inspect(key)?.workspaceValue,
      ])) as unknown as WorkspaceSettingValues;
      const launcher = vscode.workspace.getConfiguration("placekeeper").get<string>("externalLauncherPath");
      if (launcher === undefined || launcher.length === 0 || !existsSync(launcher)) {
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
