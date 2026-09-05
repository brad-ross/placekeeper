import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import electronPath from "electron";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const packageRoot = resolve(import.meta.dirname, "..");
const electronPackageRoot = dirname(require.resolve("electron/package.json"));
const electronApp = dirname(dirname(dirname(electronPath)));
const outputRoot = await mkdtemp(join(tmpdir(), "placekeeper-electron-spike-"));
const appPath = join(outputRoot, "Placekeeper Electron Spike.app");

await run("/usr/bin/ditto", [electronApp, appPath]);
const resources = join(appPath, "Contents/Resources");
const appResources = join(resources, "app");
await mkdir(appResources, { recursive: true });
for (const entry of ["package.json", "README.md", "src"]) {
  await cp(join(packageRoot, entry), join(appResources, entry), { recursive: true });
}
await cp(join(electronPackageRoot, "LICENSE"), join(resources, "ELECTRON_LICENSE"));

const plist = join(appPath, "Contents/Info.plist");
const plistCommands = [
  "Set :CFBundleName Placekeeper Electron Spike",
  "Set :CFBundleDisplayName Placekeeper Electron Spike",
  "Set :CFBundleIdentifier local.placekeeper.electron-spike",
  "Set :CFBundleShortVersionString 0.0.0",
  "Set :CFBundleVersion 0.0.0",
  "Add :LSMultipleInstancesProhibited bool true",
  "Set :LSMinimumSystemVersion 13.0",
  "Add :CFBundleDocumentTypes array",
  "Add :CFBundleDocumentTypes:0 dict",
  "Add :CFBundleDocumentTypes:0:CFBundleTypeName string PDF document",
  "Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Viewer",
  "Add :CFBundleDocumentTypes:0:LSHandlerRank string Alternate",
  "Add :CFBundleDocumentTypes:0:LSItemContentTypes array",
  "Add :CFBundleDocumentTypes:0:LSItemContentTypes:0 string com.adobe.pdf",
  "Add :CFBundleURLTypes array",
  "Add :CFBundleURLTypes:0 dict",
  "Add :CFBundleURLTypes:0:CFBundleURLName string local.placekeeper.electron-spike.review-link",
  "Add :CFBundleURLTypes:0:CFBundleTypeRole string Viewer",
  "Add :CFBundleURLTypes:0:CFBundleURLSchemes array",
  "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string placekeeper-electron-spike",
];
for (const command of plistCommands) {
  await run("/usr/libexec/PlistBuddy", ["-c", command, plist]);
}

await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath]);
await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);

process.stdout.write(`${JSON.stringify({ appPath })}\n`);
