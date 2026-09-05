import { execFile } from "node:child_process";
import { basename, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

import { app, BrowserWindow, dialog, Menu } from "electron";

import {
  canonicalPlacekeeperLink,
  createWindowOptions,
  isReviewReadyForProbe,
  requestedPdfPath,
  shouldAllowNavigation,
} from "./launch-policy.mjs";
import {
  launchPdf,
  openPlacekeeperLink,
  preflightPlacekeeperLink,
} from "./launcher-client.mjs";
import {
  createMainLifecycle,
  openLinkWithConfirmation,
} from "./main-lifecycle.mjs";

const exec = promisify(execFile);
const probeMode = process.argv.includes("--probe-json") || process.env.PLACEKEEPER_ELECTRON_PROBE === "1";
const exitAfterProbe = process.argv.includes("--exit-after-probe") || process.env.PLACEKEEPER_ELECTRON_PROBE_EXIT === "1";
const launcherPath = process.env.PLACEKEEPER_SPIKE_LAUNCHER ?? resolve(
  homedir(),
  "Applications/Placekeeper.app/Contents/MacOS/placekeeper",
);

if (!isAbsolute(launcherPath)) throw new Error("PLACEKEEPER_SPIKE_LAUNCHER must be absolute");

let mainWindow;
let quitting = false;

function parseInitialPdf() {
  try {
    return requestedPdfPath(process.argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
}

// The process receives its initial argv before static ESM imports run.
const initialPdfReceivedAt = performance.now() - (process.uptime() * 1_000);
const initialPdfPath = parseInitialPdf();

function denyUnexpectedNavigation(event, targetUrl) {
  if (!shouldAllowNavigation(targetUrl)) event.preventDefault();
}

function configureRendererBoundary(window) {
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", denyUnexpectedNavigation);
  window.webContents.on("will-redirect", denyUnexpectedNavigation);
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

function windowForReview() {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow(createWindowOptions());
  configureRendererBoundary(mainWindow);
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  return mainWindow;
}

async function emitProbe(window, pdfPath, actionReceivedAt) {
  const memory = await process.getProcessMemoryInfo();
  const preferences = window.webContents.getLastWebPreferences();
  const appMetrics = app.getAppMetrics();
  const appWorkingSetKb = appMetrics.reduce(
    (total, metric) => total + (metric.memory?.workingSetSize ?? 0),
    0,
  );
  process.stdout.write(`${JSON.stringify({
    appProcessCount: appMetrics.length,
    actionToLoadedMs: Math.round(performance.now() - actionReceivedAt),
    kind: "electron-shell-probe",
    appVersion: app.getVersion(),
    appWorkingSetKb,
    chromeVersion: process.versions.chrome,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    processToLoadedMs: Math.round(process.uptime() * 1_000),
    mainProcessPrivateKb: memory.private,
    mainProcessRssKb: Math.round(process.memoryUsage().rss / 1024),
    mainProcessSharedKb: memory.shared,
    pdfPath,
    reviewReady: true,
    renderer: {
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
      sandbox: preferences.sandbox,
      webSecurity: preferences.webSecurity,
    },
    rendererPid: window.webContents.getOSProcessId(),
    url: window.webContents.getURL(),
    windowFocused: window.isFocused(),
  })}\n`);
  if (exitAfterProbe) setTimeout(() => app.quit(), 100);
}

async function waitForReviewReady(window) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const snapshot = await window.webContents.executeJavaScript(`({
        hasPdfWorkspaceLoading: document.querySelector(".pdf-workspace__loading") !== null,
        hasProductionReview: document.querySelector("[data-production-review]") !== null,
        hasViewerFramingViewport: document.querySelector("[data-viewer-framing-viewport]") !== null,
        hasViewerStatus: document.querySelector("[data-viewer-status]") !== null,
        url: window.location.href,
      })`, true);
      if (isReviewReadyForProbe(snapshot)) return;
    } catch {
      // The bootstrap can replace its document while this bounded probe is sampling it.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("Electron loaded the shell but the PDF review did not become ready");
}

async function showReview(url, pdfPath, actionReceivedAt) {
  const window = windowForReview();
  window.setTitle(basename(pdfPath));
  window.setRepresentedFilename(pdfPath);
  app.addRecentDocument(pdfPath);
  await window.loadURL(url);
  if (!window.isVisible()) window.show();
  if (window.isMinimized()) window.restore();
  window.focus();
  if (probeMode) {
    await waitForReviewReady(window);
    await emitProbe(window, pdfPath, actionReceivedAt);
  }
}

async function performPdfOpen(action) {
  const url = await launchPdf({ exec, launcherPath, pdfPath: action.value });
  await showReview(url, action.value, action.receivedAt);
}

async function confirmLinkedPdf(pdfPath) {
  const result = await dialog.showMessageBox({
    buttons: ["Cancel", "Open"],
    cancelId: 0,
    defaultId: 0,
    detail: pdfPath,
    message: "Open this PDF in Placekeeper?",
    noLink: true,
    type: "question",
  });
  return result.response === 1;
}

async function performLinkOpen(action) {
  await openLinkWithConfirmation({
    action,
    canonicalize: canonicalPlacekeeperLink,
    confirm: confirmLinkedPdf,
    open: (link, confirmed) => openPlacekeeperLink({ confirmed, exec, launcherPath, link }),
    preflight: (link) => preflightPlacekeeperLink({ exec, launcherPath, link }),
    showReview,
  });
}

async function presentFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (probeMode) {
    process.stdout.write(`${JSON.stringify({ kind: "electron-shell-probe-error", message })}\n`);
    if (exitAfterProbe) app.exit(1);
    return;
  }
  await dialog.showMessageBox({
    buttons: ["OK"],
    message: "Placekeeper could not open this review",
    detail: message,
    type: "error",
  });
}

function focusMainWindow() {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

const lifecycle = createMainLifecycle({
  dispatchAction: (action) => action.kind === "pdf"
    ? performPdfOpen(action)
    : performLinkOpen(action),
  focusWindow: focusMainWindow,
  parseRequestedPdfPath: requestedPdfPath,
  presentFailure,
});

async function choosePdf() {
  const result = await dialog.showOpenDialog({
    filters: [{ name: "PDF documents", extensions: ["pdf"] }],
    message: "Choose one local PDF to read or annotate",
    properties: ["openFile"],
  });
  const [pdfPath] = result.filePaths;
  if (!result.canceled && pdfPath !== undefined) lifecycle.receivePdf(pdfPath);
}

function installNativeMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        { label: "Open PDF…", accelerator: "CmdOrCtrl+O", click: () => void choosePdf() },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]));
}

app.on("open-file", (event, pdfPath) => {
  event.preventDefault();
  lifecycle.receivePdf(pdfPath);
});

app.on("open-url", (event, link) => {
  event.preventDefault();
  lifecycle.receiveLink(link);
});

const gotSingleInstanceLock = app.requestSingleInstanceLock({
  pdfPath: initialPdfPath ?? null,
});

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {
    void lifecycle.handleSecondInstance({ additionalData, argv });
  });

  app.whenReady().then(async () => {
    installNativeMenu();
    if (initialPdfPath !== undefined && lifecycle.pendingCount() === 0) {
      lifecycle.enqueue(lifecycle.createPdfAction(initialPdfPath, initialPdfReceivedAt));
    }
    const hadPendingAction = lifecycle.pendingCount() > 0;
    lifecycle.markReady();
    if (!hadPendingAction) await choosePdf();
  }).catch(presentFailure);

  app.on("activate", () => {
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      mainWindow.show();
      focusMainWindow();
      return;
    }
    void choosePdf();
  });
}

app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !quitting) app.quit();
});
