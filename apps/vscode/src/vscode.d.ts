declare module "vscode" {
  export enum UIKind { Desktop = 1, Web = 2 }
  export interface Uri { readonly scheme: string; readonly fsPath: string }
  export interface Disposable { dispose(): unknown }
  export interface ExtensionContext {
    readonly subscriptions: Disposable[];
    asAbsolutePath(path: string): string;
  }
  export const env: { readonly remoteName?: string; readonly uiKind: UIKind };
  export const workspace: {
    readonly workspaceFolders?: readonly { readonly uri: Uri }[];
    getWorkspaceFolder(uri: Uri): { readonly uri: Uri } | undefined;
    getConfiguration(section: string): { get<T>(key: string): T | undefined };
  };
  export const window: {
    readonly activeTextEditor?: { readonly document: { readonly uri: Uri } };
    showErrorMessage(message: string, ...actions: string[]): Promise<string | undefined>;
    showQuickPick(items: readonly string[], options: { readonly title: string; readonly placeHolder: string }): Promise<string | undefined>;
    showOpenDialog(options: { readonly canSelectMany: false; readonly canSelectFiles: true; readonly canSelectFolders: false; readonly filters: Readonly<Record<string, readonly string[]>> }): Promise<readonly Uri[] | undefined>;
    createWebviewPanel(viewType: string, title: string, column: number, options: unknown): {
      readonly webview: {
        html: string;
        onDidReceiveMessage(listener: (message: unknown) => unknown): Disposable;
        postMessage(message: unknown): Promise<boolean>;
      };
      readonly onDidDispose: (listener: () => unknown) => Disposable;
    };
  };
  export const commands: {
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable;
    executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
  };
  export const ViewColumn: { readonly Active: number };
}
