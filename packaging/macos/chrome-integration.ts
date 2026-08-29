import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  NATIVE_HOST_NAME as EXTENSION_NATIVE_HOST_NAME,
  NATIVE_PROTOCOL_VERSION as EXTENSION_NATIVE_PROTOCOL_VERSION,
} from "../../apps/chrome-extension/src/native-protocol.js";
import {
  CHROME_EXTENSION_ID as SERVICE_EXTENSION_ID,
  CHROME_NATIVE_PROTOCOL_VERSION as SERVICE_NATIVE_PROTOCOL_VERSION,
} from "../../apps/service/src/browser/chrome-handoff.js";

export const CHROME_NATIVE_HOST_NAME = EXTENSION_NATIVE_HOST_NAME;
export const CHROME_EXTENSION_ID = SERVICE_EXTENSION_ID;
export const CHROME_EXTENSION_ORIGIN = `chrome-extension://${CHROME_EXTENSION_ID}/`;
export const CHROME_NATIVE_PROTOCOL_RANGE = {
  minimum: EXTENSION_NATIVE_PROTOCOL_VERSION,
  maximum: SERVICE_NATIVE_PROTOCOL_VERSION,
} as const;
export const CHROME_EXTENSION_BUNDLE_PATH = "Contents/Resources/integrations/chrome-extension";
export const CHROME_EXTENSION_INSTALL_DIRECTORY_NAME = "Placekeeper Chrome Extension";
export const CHROME_NATIVE_WRAPPER_BUNDLE_PATH = "Contents/MacOS/placekeeper-chrome-host";

export function chromeExtensionInstallPath(appPath: string): string {
  if (!isAbsolute(appPath) || !appPath.endsWith("/Placekeeper.app")) {
    throw new Error("Chrome extension app path must be an absolute Placekeeper.app path");
  }
  return join(dirname(appPath), CHROME_EXTENSION_INSTALL_DIRECTORY_NAME);
}

interface ChromeManifest {
  readonly manifest_version?: unknown;
  readonly version?: unknown;
  readonly minimum_chrome_version?: unknown;
  readonly key?: unknown;
  readonly permissions?: unknown;
  readonly mime_types_handler?: unknown;
}

export interface ChromeSourceContract {
  readonly extensionId: typeof CHROME_EXTENSION_ID;
  readonly extensionOrigin: typeof CHROME_EXTENSION_ORIGIN;
  readonly hostName: typeof CHROME_NATIVE_HOST_NAME;
  readonly minimumChromeVersion: 151;
  readonly protocol: typeof CHROME_NATIVE_PROTOCOL_RANGE;
}

export interface ChromeNativeHostManifest {
  readonly name: typeof CHROME_NATIVE_HOST_NAME;
  readonly description: "Placekeeper Chrome PDF handoff";
  readonly path: string;
  readonly type: "stdio";
  readonly allowed_origins: readonly [typeof CHROME_EXTENSION_ORIGIN];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deriveChromeExtensionId(key: string): string {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...digest].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

export function validateChromeSourceContract(manifest: ChromeManifest): ChromeSourceContract {
  if (
    EXTENSION_NATIVE_PROTOCOL_VERSION !== SERVICE_NATIVE_PROTOCOL_VERSION ||
    EXTENSION_NATIVE_HOST_NAME !== "com.placekeeper.chrome"
  ) throw new Error("Chrome extension and native host protocol contracts do not match");
  if (
    manifest.manifest_version !== 3 ||
    manifest.minimum_chrome_version !== "151" ||
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:\.\d+)?$/u.test(manifest.version)
  ) throw new Error("Chrome extension version or minimum browser version is invalid");
  if (typeof manifest.key !== "string" || deriveChromeExtensionId(manifest.key) !== CHROME_EXTENSION_ID) {
    throw new Error("Chrome extension key and stable ID do not match");
  }
  if (
    !Array.isArray(manifest.permissions) ||
    manifest.permissions.length !== 2 ||
    manifest.permissions[0] !== "nativeMessaging" ||
    manifest.permissions[1] !== "storage"
  ) throw new Error("Chrome extension permissions changed");
  if (
    !isRecord(manifest.mime_types_handler) ||
    JSON.stringify(manifest.mime_types_handler) !==
      JSON.stringify({ "application/pdf": { handler_url: "handler.html" } })
  ) throw new Error("Chrome extension must remain a top-level PDF-only handler");
  return {
    extensionId: CHROME_EXTENSION_ID,
    extensionOrigin: CHROME_EXTENSION_ORIGIN,
    hostName: CHROME_NATIVE_HOST_NAME,
    minimumChromeVersion: 151,
    protocol: CHROME_NATIVE_PROTOCOL_RANGE,
  };
}

export function renderChromeNativeHostManifest(appPath: string): ChromeNativeHostManifest {
  if (!isAbsolute(appPath) || !appPath.endsWith("/Placekeeper.app")) {
    throw new Error("Native host app path must be an absolute Placekeeper.app path");
  }
  return {
    name: CHROME_NATIVE_HOST_NAME,
    description: "Placekeeper Chrome PDF handoff",
    path: join(appPath, CHROME_NATIVE_WRAPPER_BUNDLE_PATH),
    type: "stdio",
    allowed_origins: [CHROME_EXTENSION_ORIGIN],
  };
}

function assertNativeHostManifestShape(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !==
    ["allowed_origins", "description", "name", "path", "type"].join("\0")) {
    throw new Error("Chrome native host manifest has unexpected fields");
  }
}

function validateNativeHostManifest(value: unknown, appPath: string): ChromeNativeHostManifest {
  assertNativeHostManifestShape(value);
  const expected = renderChromeNativeHostManifest(appPath);
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error("Chrome native host manifest does not match the packaged endpoint");
  }
  return expected;
}

async function validateInstalledNativeHostManifest(
  value: unknown,
  appPath: string,
): Promise<void> {
  assertNativeHostManifestShape(value);
  const expected = renderChromeNativeHostManifest(appPath);
  if (typeof value.path === "string" && isAbsolute(value.path)) {
    await assertSecureEntry(value.path, "file");
  }
  if (
    value.name !== expected.name ||
    value.description !== expected.description ||
    value.type !== expected.type ||
    JSON.stringify(value.allowed_origins) !== JSON.stringify(expected.allowed_origins) ||
    typeof value.path !== "string" || !isAbsolute(value.path) ||
    await realpath(value.path) !== await realpath(expected.path)
  ) throw new Error("Chrome native host manifest does not match the packaged endpoint");
}

async function assertSecureEntry(path: string, kind: "directory" | "file"): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("Chrome integration path must not be a symbolic link");
  if ((info.mode & 0o022) !== 0) throw new Error("Chrome integration path must not be group/world writable");
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) {
    throw new Error(`Chrome integration ${kind} has the wrong type`);
  }
}

async function assertSecureRegistrationEntry(
  path: string,
  kind: "directory" | "file",
): Promise<void> {
  await assertSecureEntry(path, kind);
  const info = await lstat(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && info.uid !== uid) {
    throw new Error("Chrome registration path must be owned by the current user");
  }
}

async function assertSecureRegistrationPath(userHome: string, hostPath: string): Promise<void> {
  const root = resolve(userHome);
  const parent = dirname(hostPath);
  const suffix = relative(root, parent);
  if (suffix.startsWith("..") || isAbsolute(suffix)) {
    throw new Error("Chrome registration path must remain below the user home");
  }
  let current = root;
  await assertSecureRegistrationEntry(current, "directory");
  for (const component of suffix.split("/").filter(Boolean)) {
    current = join(current, component);
    await assertSecureRegistrationEntry(current, "directory");
  }
  await assertSecureRegistrationEntry(hostPath, "file");
}

async function assertSecureTree(root: string): Promise<void> {
  await assertSecureEntry(root, "directory");
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Chrome integration path must not be a symbolic link");
      if (entry.isDirectory()) {
        await assertSecureEntry(path, "directory");
        await visit(path);
      } else {
        await assertSecureEntry(path, "file");
      }
    }
  };
  await visit(root);
}

export async function validateChromeExtensionDirectory(
  extensionPath: string,
): Promise<ChromeSourceContract> {
  await assertSecureTree(extensionPath);
  const contract = validateChromeSourceContract(
    JSON.parse(await readFile(join(extensionPath, "manifest.json"), "utf8")) as ChromeManifest,
  );
  for (const entry of ["handler.html", "popup.html", "background.js"] as const) {
    await assertSecureEntry(join(extensionPath, entry), "file");
  }
  return contract;
}

export async function validateChromeIntegrationBundle(appPath: string): Promise<ChromeSourceContract> {
  if (!isAbsolute(appPath)) throw new Error("Chrome integration app path must be absolute");
  await assertSecureEntry(appPath, "directory");
  const canonicalAppPath = await realpath(appPath);
  const extensionPath = join(appPath, CHROME_EXTENSION_BUNDLE_PATH);
  const wrapperPath = join(appPath, CHROME_NATIVE_WRAPPER_BUNDLE_PATH);
  const contract = await validateChromeExtensionDirectory(extensionPath);
  await assertSecureEntry(wrapperPath, "file");
  const wrapper = await lstat(wrapperPath);
  if ((wrapper.mode & 0o111) === 0) throw new Error("Chrome native wrapper must be executable");
  if (
    await realpath(extensionPath) !== join(canonicalAppPath, CHROME_EXTENSION_BUNDLE_PATH) ||
    await realpath(wrapperPath) !== join(canonicalAppPath, CHROME_NATIVE_WRAPPER_BUNDLE_PATH)
  ) {
    throw new Error("Chrome integration endpoints must be canonical paths");
  }
  return contract;
}

export type ChromeInstallationStatus =
  | "healthy"
  | "app-incomplete"
  | "native-host-unavailable"
  | "native-host-mismatch"
  | "extension-not-loaded"
  | "extension-id-mismatch"
  | "extension-path-mismatch";

export interface ChromeInstallationEvidence {
  readonly ok: boolean;
  readonly status: ChromeInstallationStatus;
  readonly action:
    | "none"
    | "reinstall-placekeeper"
    | "load-packaged-extension"
    | "reload-packaged-extension";
  readonly extensionId: typeof CHROME_EXTENSION_ID;
  readonly protocol: 1;
}

interface ChromeInstallationOptions {
  readonly appPath: string;
  readonly userHome: string;
}

function evidence(
  status: ChromeInstallationStatus,
  action: ChromeInstallationEvidence["action"],
): ChromeInstallationEvidence {
  return {
    ok: status === "healthy",
    status,
    action,
    extensionId: CHROME_EXTENSION_ID,
    protocol: CHROME_NATIVE_PROTOCOL_RANGE.maximum,
  };
}

async function chromePreferenceFiles(userHome: string): Promise<string[]> {
  const chromeRoot = join(userHome, "Library/Application Support/Google/Chrome");
  let entries;
  try {
    entries = await readdir(chromeRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && (entry.name === "Default" || /^Profile \d+$/u.test(entry.name)))
    .map((entry) => join(chromeRoot, entry.name, "Preferences"));
}

export async function inspectChromeInstallation(
  options: ChromeInstallationOptions,
): Promise<ChromeInstallationEvidence> {
  try {
    await validateChromeIntegrationBundle(options.appPath);
  } catch {
    return evidence("app-incomplete", "reinstall-placekeeper");
  }
  const hostPath = join(
    options.userHome,
    "Library/Application Support/Google/Chrome/NativeMessagingHosts",
    `${CHROME_NATIVE_HOST_NAME}.json`,
  );
  try {
    await assertSecureRegistrationPath(options.userHome, hostPath);
    await validateInstalledNativeHostManifest(
      JSON.parse(await readFile(hostPath, "utf8")) as unknown,
      options.appPath,
    );
  } catch (error) {
    return evidence(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "native-host-unavailable"
        : "native-host-mismatch",
      "reinstall-placekeeper",
    );
  }

  const expectedPath = chromeExtensionInstallPath(options.appPath);
  try {
    await validateChromeExtensionDirectory(expectedPath);
  } catch {
    return evidence("app-incomplete", "reinstall-placekeeper");
  }
  let expectedIdAtWrongPath = false;
  let expectedPathAtWrongId = false;
  for (const path of await chromePreferenceFiles(options.userHome)) {
    let preferences: unknown;
    try {
      preferences = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(preferences) || !isRecord(preferences.extensions) ||
      !isRecord(preferences.extensions.settings)) continue;
    for (const [id, rawSetting] of Object.entries(preferences.extensions.settings)) {
      if (!isRecord(rawSetting) || typeof rawSetting.path !== "string") continue;
      const settingPath = resolve(rawSetting.path);
      if (id === CHROME_EXTENSION_ID && settingPath === expectedPath) {
        return evidence("healthy", "none");
      }
      if (id === CHROME_EXTENSION_ID) expectedIdAtWrongPath = true;
      if (settingPath === expectedPath) expectedPathAtWrongId = true;
    }
  }
  if (expectedPathAtWrongId) return evidence("extension-id-mismatch", "reload-packaged-extension");
  if (expectedIdAtWrongPath) return evidence("extension-path-mismatch", "reload-packaged-extension");
  return evidence("extension-not-loaded", "load-packaged-extension");
}

export function parseChromeNativeHostManifest(value: unknown, appPath: string): ChromeNativeHostManifest {
  return validateNativeHostManifest(value, appPath);
}
