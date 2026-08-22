import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import * as vscode from "vscode";
import { runLaunchClient } from "./launch-client.js";
import {
  INPUT_UNAVAILABLE,
  choosePdfUriInput,
  classifyWorkspace,
  localSourceRoot,
  resolveLauncherPath,
  type LaunchErrorPresentation,
  type UriLike,
} from "./local-workspace.js";
import { buildReviewWebviewHtml, reviewPanelOptions } from "./review-panel.js";

const COMMAND = "placekeeper.open";

async function showSharedError(error: LaunchErrorPresentation): Promise<void> {
  const selected = await vscode.window.showErrorMessage(
    error.message,
    error.recoveryAction,
  );
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
    if (chosen?.[0] !== undefined) await vscode.commands.executeCommand(COMMAND, chosen[0]);
  }
}

function selectedUris(first: unknown, many: unknown): UriLike[] {
  if (Array.isArray(many)) return many as UriLike[];
  if (typeof first === "object" && first !== null) return [first as UriLike];
  return [];
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND, async (...commandArgs: unknown[]) => {
      const workspaceError = classifyWorkspace({
        ...(vscode.env.remoteName === undefined ? {} : { remoteName: vscode.env.remoteName }),
        uiKind: vscode.env.uiKind === vscode.UIKind.Desktop ? "desktop" : "web",
        workspaceSchemes: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.scheme),
      });
      if (workspaceError !== undefined) {
        await showSharedError(workspaceError);
        return;
      }

      const pdfUri = choosePdfUriInput({
        ...(vscode.window.activeTextEditor === undefined
          ? {}
          : { active: vscode.window.activeTextEditor.document.uri }),
        selected: selectedUris(commandArgs[0], commandArgs[1]),
      });
      if (!("scheme" in pdfUri)) {
        await showSharedError(pdfUri);
        return;
      }

      const configured = vscode.workspace
        .getConfiguration("placekeeper")
        .get<string>("launcherPath");
      const executable = resolveLauncherPath(configured, homedir());
      try {
        const sourceRoot = localSourceRoot(
          pdfUri,
          vscode.workspace.getWorkspaceFolder(pdfUri)?.uri,
        );
        let result = await runLaunchClient(executable, pdfUri.fsPath, sourceRoot);
        while (result.ok && result.kind === "recovery-offered") {
          const decision = await vscode.window.showQuickPick(result.choices, {
            title: "Recover Placekeeper draft",
            placeHolder: "Resume, discard, or start an independent review",
          });
          if (decision !== "resume" && decision !== "discard" && decision !== "fork") return;
          result = await runLaunchClient(
            executable,
            pdfUri.fsPath,
            sourceRoot,
            undefined,
            {
              decision,
              offer: result.recoveryOffer,
              operationId: randomBytes(18).toString("base64url"),
            },
          );
        }
        if (!result.ok) {
          await showSharedError(result.error);
          return;
        }
        const panel = vscode.window.createWebviewPanel(
          "placekeeper.review",
          "Placekeeper",
          vscode.ViewColumn.Active,
          reviewPanelOptions,
        );
        panel.webview.onDidReceiveMessage(async (message: unknown) => {
          if (
            typeof message === "object" &&
            message !== null &&
            (message as { type?: unknown }).type === "ready"
          ) {
            await panel.webview.postMessage({ type: "launch-url", url: result.url });
          }
        });
        panel.webview.html = buildReviewWebviewHtml(
          result.url,
          randomBytes(18).toString("base64url"),
        );
      } catch {
        await showSharedError(INPUT_UNAVAILABLE);
      }
    }),
  );
}

export function deactivate(): void {}
