declare module "vscode" {
  export enum UIKind { Desktop = 1, Web = 2 }
  export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
  export interface Uri { readonly scheme: string; readonly fsPath: string; readonly path: string; readonly query: string; toString(): string }
  export const Uri: { file(path: string): Uri; joinPath(base: Uri, ...segments: string[]): Uri };
  export interface Disposable { dispose(): unknown }
  export interface Memento { get<T>(key: string): T | undefined; update(key: string, value: unknown): Promise<void> }
  export interface ExtensionContext {
    readonly subscriptions: Disposable[];
    readonly globalStorageUri: Uri;
    readonly globalState: Memento;
    readonly workspaceState: Memento;
    asAbsolutePath(path: string): string;
  }
  export const env: { readonly remoteName?: string; readonly uiKind: UIKind };
  export interface TextDocument { readonly uri: Uri; readonly languageId: string }
  export interface Position { readonly line: number; readonly character: number }
  export const Position: new (line: number, character: number) => Position;
  export interface Range { readonly start: Position; readonly end: Position }
  export const Range: new (start: Position, end: Position) => Range;
  export interface Selection { readonly anchor: Position; readonly active: Position }
  export const Selection: new (anchor: Position, active: Position) => Selection;
  export interface TextEditor { readonly document: TextDocument; selection: Selection; revealRange(range: Range): void }
  export interface WorkspaceFolder { readonly uri: Uri }
  export interface WorkspaceConfiguration {
    get<T>(key: string): T | undefined;
    inspect<T>(key: string): { readonly workspaceValue?: T } | undefined;
    update(key: string, value: unknown, target: ConfigurationTarget): Promise<void>;
  }
  export interface FileSystemWatcher extends Disposable {
    onDidCreate(listener: (uri: Uri) => unknown): Disposable;
    onDidChange(listener: (uri: Uri) => unknown): Disposable;
    onDidDelete(listener: (uri: Uri) => unknown): Disposable;
  }
  export class RelativePattern { constructor(base: string | WorkspaceFolder, pattern: string) }
  export const workspace: {
    readonly isTrusted: boolean;
    readonly workspaceFolders?: readonly WorkspaceFolder[];
    getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined;
    getConfiguration(section?: string): WorkspaceConfiguration;
    findFiles(include: string, exclude?: string, maxResults?: number): Promise<readonly Uri[]>;
    createFileSystemWatcher(glob: RelativePattern): FileSystemWatcher;
    onDidSaveTextDocument(listener: (document: TextDocument) => unknown): Disposable;
    openTextDocument(uri: Uri): Promise<TextDocument>;
  };
  export interface Webview {
    html: string;
    options: unknown;
    readonly cspSource: string;
    asWebviewUri(uri: Uri): Uri;
    onDidReceiveMessage(listener: (message: unknown) => unknown): Disposable;
    postMessage(message: unknown): Promise<boolean>;
  }
  export interface WebviewPanel extends Disposable {
    readonly webview: Webview;
    readonly active: boolean;
    readonly visible: boolean;
    viewColumn?: number;
    reveal(viewColumn?: number, preserveFocus?: boolean): void;
    onDidDispose(listener: () => unknown): Disposable;
    onDidChangeViewState(listener: (event: { readonly webviewPanel: WebviewPanel }) => unknown): Disposable;
  }
  export interface WebviewPanelSerializer { deserializeWebviewPanel(webviewPanel: WebviewPanel, state: unknown): Promise<void> }
  export interface UriHandler { handleUri(uri: Uri): unknown }
  export interface Tab { readonly input: unknown }
  export interface TabGroup { readonly activeTab?: Tab }
  export interface TabGroups { readonly activeTabGroup: TabGroup }
  export const window: {
    readonly activeTextEditor?: TextEditor;
    readonly tabGroups: TabGroups;
    showErrorMessage(message: string, ...actions: string[]): Promise<string | undefined>;
    showWarningMessage(message: string, ...actions: string[]): Promise<string | undefined>;
    showInformationMessage(message: string, ...actions: string[]): Promise<string | undefined>;
    showQuickPick(items: readonly string[], options: { readonly title: string; readonly placeHolder: string }): Promise<string | undefined>;
    showOpenDialog(options: { readonly canSelectMany: false; readonly canSelectFiles: true; readonly canSelectFolders: false; readonly filters: Readonly<Record<string, readonly string[]>> }): Promise<readonly Uri[] | undefined>;
    createWebviewPanel(viewType: string, title: string, column: number, options: unknown): WebviewPanel;
    registerWebviewPanelSerializer(viewType: string, serializer: WebviewPanelSerializer): Disposable;
    registerUriHandler(handler: UriHandler): Disposable;
    showTextDocument(document: TextDocument, options?: { readonly preview?: boolean; readonly preserveFocus?: boolean }): Promise<TextEditor>;
  };
  export const commands: {
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable;
    executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
    getCommands(filterInternal?: boolean): Promise<readonly string[]>;
  };
  export interface Extension<T = unknown> { readonly packageJSON: { readonly version?: string }; activate(): Promise<T> }
  export const extensions: { getExtension<T = unknown>(id: string): Extension<T> | undefined };
  export const ViewColumn: { readonly Active: number; readonly Beside: number };
}
