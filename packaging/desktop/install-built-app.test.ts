import { establishPrivateDirectory } from "../../apps/service/src/platform/private-storage.js";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { installBuiltApp, uninstallApp, runtimeRoot } from "./install-built-app.mjs";
import { acquireLifecycleLock } from "../../apps/service/src/host/lifecycle-lock.js";
import { desktopExecutable } from "./launcher.mjs";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function app(path: string) {
  const root = runtimeRoot(path);
  for (const directory of ["node/bin", "service", "web"]) await mkdir(join(root, directory), { recursive: true });
  const node = `node/bin/node${process.platform === "win32" ? ".exe" : ""}`;
  await writeFile(join(root, node), "node", {mode:0o755});
  await writeFile(join(root, "service/main.js"), "service");
  await writeFile(join(root, "web/pdfium.wasm"), "wasm");
  await mkdir(dirname(desktopExecutable(root)), { recursive: true });
  await writeFile(desktopExecutable(root), "Electron", {mode:0o755});
  await writeFile(join(root, "runtime-manifest.json"), JSON.stringify({ schemaVersion: 1, target: { platform: process.platform, arch: process.arch }, daemonIdentity: "a".repeat(64), installArtifactIdentity: "b".repeat(64), node: { path: node, sha256: hash("node") }, service: { path: "service/main.js", sha256: hash("service") }, webAssets: { path: "web", files: [{ path: "pdfium.wasm", sha256: hash("wasm") }] } }));
}
describe("desktop replacement transaction", () => {
  it("commits a complete installation only after exact readiness succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "pk-install-success-"));
    await establishPrivateDirectory(root);
    try {
      const built = join(root, "built"), installed = join(root, "installed");
      await app(built);
      const readiness = process.platform === "darwin" ? join(installed, "Contents/MacOS/placekeeper") : join(runtimeRoot(installed), "bin", `placekeeper${process.platform === "win32" ? ".exe" : ""}`);
      const lease = await acquireLifecycleLock(join(root, 'lifecycle.lock'));
      const context = { lockPath:join(root,'lifecycle.lock'),lockToken:lease.token,backupRoot:join(root,'backup') };
      const calls: string[][] = [];
      await installBuiltApp(built, installed, readiness, undefined, async (_executable: string, args: string[], options: {env:NodeJS.ProcessEnv}) => { calls.push(args); if(options.env.PLACEKEEPER_STARTUP_REQUEST){const request=JSON.parse(options.env.PLACEKEEPER_STARTUP_REQUEST);await writeFile(request.receipt,JSON.stringify({...request,pid:2147483647,rendererReady:true}));await writeFile(`${request.receipt}.started`,JSON.stringify({...request,pid:2147483647}));} }, undefined, context);
      await lease.release();
      expect(calls.map(args => args[1])).toEqual(["ensure-ready", undefined]);
      expect(await readFile(desktopExecutable(runtimeRoot(installed)), "utf8")).toBe("Electron");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("restores the prior app only after retiring a failed exact-readiness candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "pk-install-"));
    await establishPrivateDirectory(root);
    try {
      const built = join(root, "built"), installed = join(root, "installed");
      await app(built); await app(installed); await writeFile(join(installed, "old"), "prior installation");
      const readiness = process.platform === "darwin" ? join(installed, "Contents/MacOS/placekeeper") : join(runtimeRoot(installed), "bin", `placekeeper${process.platform === "win32" ? ".exe" : ""}`);
      const lease = await acquireLifecycleLock(join(root, 'lifecycle.lock'));
      const context = { lockPath:join(root,'lifecycle.lock'),lockToken:lease.token,backupRoot:join(root,'backup') };
      const calls: string[][] = [];
      await expect(installBuiltApp(built, installed, readiness, undefined, async (_executable: string, args: string[]) => {
        calls.push(args);
        if (args[1] === "ensure-ready") { await writeFile(args[3]!, JSON.stringify({pid:2147483647})); throw new Error("readiness failure"); }
      }, undefined, context)).rejects.toThrow("readiness failure");
      await lease.release();
      expect(calls.map(args => args[1])).toEqual(["ensure-ready", "stop-ready"]);
      expect(await readFile(join(installed, "old"), "utf8")).toBe("prior installation");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

it.runIf(process.platform==='darwin')('preserves quarantine metadata through the actual macOS activation staging copy',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pk-install-metadata-'));
  const lease=await acquireLifecycleLock(join(root,'lifecycle.lock'));
  try {
    const built=join(root,'candidate.app'),installed=join(root,'installed.app');await app(built);
    const quarantine='0083;65f00000;NativeInstallerFixture;00000000-0000-0000-0000-000000000000';
    const execute=promisify(execFile);
    await execute('/usr/bin/xattr',['-w','com.apple.quarantine',quarantine,built]);
    await execute('/usr/bin/xattr',['-w','com.apple.quarantine',quarantine,desktopExecutable(runtimeRoot(built))]);
    await installBuiltApp(built,installed,join(installed,'Contents/MacOS/placekeeper'),undefined,async(_executable: string,_args: string[],options:{env:NodeJS.ProcessEnv})=>{
      if(options.env.PLACEKEEPER_STARTUP_REQUEST){const request=JSON.parse(options.env.PLACEKEEPER_STARTUP_REQUEST);await writeFile(request.receipt,JSON.stringify({...request,pid:2147483647,rendererReady:true}));await writeFile(`${request.receipt}.started`,JSON.stringify({...request,pid:2147483647}));}
    },undefined,{lockPath:join(root,'lifecycle.lock'),lockToken:lease.token,backupRoot:join(root,'backup')});
    // Native ditto can normalize attribution and add the copied-file flag.
    // Every original quarantine protection bit must survive; never rewrite it.
    const sourceProtection=parseInt(quarantine.split(';')[0]!,16);
    for(const path of [installed,desktopExecutable(runtimeRoot(installed))]) {
      const preserved=(await execute('/usr/bin/xattr',['-p','com.apple.quarantine',path])).stdout.trim();
      expect(preserved).not.toBe('');
      expect(parseInt(preserved.split(';')[0]!,16)&sourceProtection).toBe(sourceProtection);
    }
  } finally {await lease.release();await rm(root,{recursive:true,force:true});}
});

it.runIf(process.platform==='darwin')('guarded macOS uninstall retains the complete app including unknown contents and leaves state intact',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pk-uninstall-'));
  const lease=await acquireLifecycleLock(join(root,'lifecycle.lock'));
  const keys=['PLACEKEEPER_LIFECYCLE_LOCK_PATH','PLACEKEEPER_LIFECYCLE_LOCK_TOKEN','PLACEKEEPER_INSTALL_BACKUP_ROOT'] as const;
  const saved=keys.map(key=>process.env[key]);
  try {
    const built=join(root,'candidate.app'),installed=join(root,'installed.app');await app(built);await app(installed);
    await writeFile(join(installed,'unknown-user-file'),'preserve unknown contents');await writeFile(join(root,'protected-state'),'new user data');
    process.env.PLACEKEEPER_LIFECYCLE_LOCK_PATH=join(root,'lifecycle.lock');process.env.PLACEKEEPER_LIFECYCLE_LOCK_TOKEN=lease.token;process.env.PLACEKEEPER_INSTALL_BACKUP_ROOT=join(root,'backup');
    await uninstallApp(built,installed,undefined,undefined,undefined,root);
    await expect(readFile(join(installed,'unknown-user-file'))).rejects.toMatchObject({code:'ENOENT'});
    const { readdir }=await import('node:fs/promises');
    const transactions=join(root,'.placekeeper-install-transactions');const destinationHash=(await readdir(transactions))[0]!;
    const attempts=await readdir(join(transactions,destinationHash));
    const journal=JSON.parse(await readFile(join(transactions,destinationHash,attempts[0]!,'uninstall.json'),'utf8'));
    expect(journal.phase).toBe('complete');expect(await readFile(join(journal.previous,'unknown-user-file'),'utf8')).toBe('preserve unknown contents');
    expect(await readFile(join(root,'protected-state'),'utf8')).toBe('new user data');
  } finally {for(const [index,key] of keys.entries()){if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];}await lease.release();await rm(root,{recursive:true,force:true});}
});

it('refuses to retain or rename an unrelated existing directory selected as the destination',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pk-unrelated-target-'));
  await establishPrivateDirectory(root);
  const lease=await acquireLifecycleLock(join(root,'lifecycle.lock'));
  try {
    const built=join(root,'candidate'),destination=join(root,'Documents');await app(built);await mkdir(destination);await writeFile(join(destination,'review.pdf'),'unrelated document');
    const readiness=process.platform==='darwin'?join(destination,'Contents/MacOS/placekeeper'):join(runtimeRoot(destination),'bin',`placekeeper${process.platform==='win32'?'.exe':''}`);
    await expect(installBuiltApp(built,destination,readiness,undefined,async()=>{throw Error('must not run');},root,{lockPath:join(root,'lifecycle.lock'),lockToken:lease.token,backupRoot:join(root,'backup')})).rejects.toThrow('not a recognized complete Placekeeper installation');
    expect(await readFile(join(destination,'review.pdf'),'utf8')).toBe('unrelated document');
    await expect(lstat(join(root,'.placekeeper-install-transactions'))).rejects.toMatchObject({code:'ENOENT'});
  } finally {await lease.release();await rm(root,{recursive:true,force:true});}
});

it.runIf(process.platform==='darwin')('recognizes the source-derived public macOS legacy app and retains it through a guarded upgrade',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pk-public-legacy-target-'));const lease=await acquireLifecycleLock(join(root,'lifecycle.lock'));
  try {
    const built=join(root,'candidate.app'),destination=join(root,'Placekeeper.app');await app(built);
    for(const path of ['Contents/MacOS','Contents/Resources/node/bin','Contents/Resources/service','Contents/Resources/web'])await mkdir(join(destination,path),{recursive:true});
    await writeFile(join(destination,'Contents/Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.placekeeper</string><key>CFBundleExecutable</key><string>PlacekeeperMac</string><key>CFBundleShortVersionString</key><string>0.2.4</string><key>CFBundleVersion</key><string>0.2.4</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
    await writeFile(join(destination,'Contents/Resources/build-identity.json'),JSON.stringify({managementProtocolVersion:1,daemonIdentity:'c'.repeat(64),installArtifactIdentity:'d'.repeat(64)}));
    for(const path of ['Contents/MacOS/PlacekeeperMac','Contents/MacOS/placekeeper','Contents/Resources/node/bin/node','Contents/Resources/launcher.mjs','Contents/Resources/service/main.js','Contents/Resources/web/app.js','Contents/Resources/web/pdfium.wasm']){await writeFile(join(destination,path),'public-layout fixture');await chmod(join(destination,path),0o755);}
    await writeFile(join(destination,'unknown-retained-file'),'legacy contents');
    const result=await installBuiltApp(built,destination,join(destination,'Contents/MacOS/placekeeper'),undefined,async(_executable:string,_args:string[],options:{env:NodeJS.ProcessEnv})=>{
      if(options.env.PLACEKEEPER_STARTUP_REQUEST){const request=JSON.parse(options.env.PLACEKEEPER_STARTUP_REQUEST);await writeFile(request.receipt,JSON.stringify({...request,pid:2147483647,rendererReady:true}));await writeFile(`${request.receipt}.started`,JSON.stringify({...request,pid:2147483647}));}
    },root,{lockPath:join(root,'lifecycle.lock'),lockToken:lease.token,backupRoot:join(root,'backup')});
    expect(result.phase).toBe('complete');expect(await readFile(join(result.previous,'unknown-retained-file'),'utf8')).toBe('legacy contents');
  } finally {await lease.release();await rm(root,{recursive:true,force:true});}
});
