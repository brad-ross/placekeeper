import { test, expect } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { addPageNote } from "../../packages/core/src/review-commands.js";
import type { PdfWriter } from "../../packages/core/src/pdf-writer.js";
import { DraftSnapshotStore } from "../../apps/service/src/recovery/draft-snapshot.js";
import { PdfSaveCoordinator } from "../../apps/service/src/saving/pdf-save-coordinator.js";
import { closeWindowsNativeWorker } from "../../apps/service/src/platform/windows-native-worker.js";
import { windowsPowerShellScript } from "../../apps/service/src/platform/windows-powershell.js";
import { SessionBroker } from "../../apps/service/src/sessions/session-broker.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encode = (script: string) => Buffer.from(windowsPowerShellScript(script), "utf16le").toString("base64");

interface FixtureWrite { readonly revision: number; readonly annotationCount: number }
function fixtureWriter(original: Uint8Array, reviewed: Uint8Array, calls: FixtureWrite[]): PdfWriter {
  return { write: async request => {
    if (calls.length < 16) calls.push({ revision: request.revision, annotationCount: request.annotations.length });
    const bytes = request.revision > 0 && request.annotations.length > 0 ? reviewed : original;
    return {
      pdfBytes: bytes,
      evidence: { backend: "embedpdf", backendVersion: "test", originalSha256: request.sourceSha256,
        outputSha256: sha(bytes), pageCount: 1, structurallyValid: true,
        preexistingAnnotationIds: [], annotations: [] },
    };
  } };
}

async function probeSharingDenial(powershell: string, target: string, renameTarget: string): Promise<void> {
  const { stdout } = await promisify(execFile)(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encode(`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SharingProbe {
 [DllImport("kernel32.dll", EntryPoint="MoveFileExW", CharSet=CharSet.Unicode, SetLastError=true)]
 [return: MarshalAs(UnmanagedType.Bool)]
 private static extern bool Move(string source, string target, uint flags);
 [DllImport("kernel32.dll", EntryPoint="DeleteFileW", CharSet=CharSet.Unicode, SetLastError=true)]
 [return: MarshalAs(UnmanagedType.Bool)]
 private static extern bool Delete(string path);
 public static int RenameCode(string source, string target) { return Move(source, target, 8) ? 0 : Marshal.GetLastWin32Error(); }
 public static int DeleteCode(string path) { return Delete(path) ? 0 : Marshal.GetLastWin32Error(); }
}
'@
$renameCode=[SharingProbe]::RenameCode($env:PLACEKEEPER_LOCK_TARGET,$env:PLACEKEEPER_PROBE_TARGET)
$deleteCode=[SharingProbe]::DeleteCode($env:PLACEKEEPER_LOCK_TARGET)
[Console]::Out.Write((@{ renameCode=$renameCode; deleteCode=$deleteCode } | ConvertTo-Json -Compress))
`)], { env: { ...process.env, PLACEKEEPER_LOCK_TARGET: target, PLACEKEEPER_PROBE_TARGET: renameTarget }, windowsHide: true, timeout: 20_000 });
  expect(JSON.parse(stdout), "independent native rename/delete must both fail with ERROR_SHARING_VIOLATION").toEqual({
    renameCode: 32, deleteCode: 32,
  });
}

// This exercises a real Windows sharing denial, not a mocked rename errno.
// The writer is deterministic so publication/recovery is isolated from PDF IO.
test("a Windows sharing lock preserves original bytes and accepted recovery, then explicit retry saves with its ACL", async () => {
  test.skip(process.platform !== "win32", "Requires real Windows file sharing and ACL semantics");
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "placekeeper-sharing-"));
  const target = join(directory, "paper.pdf");
  const releasePath = join(directory, `release-${randomUUID()}`);
  const original = Buffer.from("%PDF-1.7\noriginal\n%%EOF");
  const reviewed = Buffer.from("%PDF-1.7\nreviewed note\n%%EOF");
  const writerCalls: FixtureWrite[] = [];
  await writeFile(target, original);
  const broker = new SessionBroker({ recoveryRoot: join(directory, "recovery"), portableReader: async () => [] });
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let holder: ReturnType<typeof spawn> | undefined;
  let releaseRequested = false;
  let unexpectedExit = false;
  function assertHolding(): void {
    expect(unexpectedExit, "lock holder must remain alive until explicit release").toBe(false);
    expect(holder?.exitCode).toBe(null);
    expect(holder?.signalCode).toBe(null);
  }
  async function releaseHolder(): Promise<void> {
    if (holder === undefined) return;
    const current = holder;
    releaseRequested = true;
    if (current.exitCode === null && current.signalCode === null) {
      const closed = once(current, "close");
      const terminate = setTimeout(() => current.kill(), 5_000);
      try { await writeFile(releasePath, "release"); await closed; }
      finally { clearTimeout(terminate); }
    }
    holder = undefined;
  }
  try {
    const opened = await broker.openReview({ pdfPath: target });
    if (opened.kind !== "opened") throw new Error("Expected fresh review");
    const sessionId = opened.launch.sessionId;
    const writer = fixtureWriter(original, reviewed, writerCalls);
    const coordinator = new PdfSaveCoordinator({ broker, writer,
      verify: async ({ annotations }) => ({ pageCount: 1, annotationIds: annotations.map(item => item.id) }) });
    await coordinator.chooseOriginal(sessionId);
    expect(await readFile(target), `writer requests after choosing original: ${JSON.stringify(writerCalls)}`).toEqual(original);
    holder = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encode(`
$ErrorActionPreference = 'Stop'
$path = $env:PLACEKEEPER_LOCK_TARGET
$acl = Get-Acl -LiteralPath $path
$acl.SetAccessRuleProtection($true, $false)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
Set-Acl -LiteralPath $path -AclObject $acl
$handle = [System.IO.File]::Open($path, 'Open', 'Read', 'Read')
[Console]::Out.WriteLine('LOCKED|' + (Get-Acl -LiteralPath $path).Sddl)
[Console]::Out.Flush()
try {
 $deadline=[DateTime]::UtcNow.AddSeconds(100)
 while (-not [IO.File]::Exists($env:PLACEKEEPER_LOCK_RELEASE)) {
  if ([DateTime]::UtcNow -gt $deadline) { throw 'Lock release deadline expired' }
  [Threading.Thread]::Sleep(25)
 }
} finally { $handle.Dispose() }
`)], { env: { ...process.env, PLACEKEEPER_LOCK_TARGET: target, PLACEKEEPER_LOCK_RELEASE: releasePath }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const lockProcess = holder;
    lockProcess.once("exit", () => { if (!releaseRequested) unexpectedExit = true; });
    const lockedAcl = await new Promise<string>((resolve, reject) => {
      let output = "";
      let errors = "";
      lockProcess.stdout!.on("data", chunk => {
        output += chunk.toString();
        const match = /^LOCKED\|([^\r\n]+)[\r\n]/u.exec(output);
        if (match !== null) resolve(match[1]!);
      });
      lockProcess.stderr!.on("data", chunk => { errors += chunk.toString(); });
      lockProcess.once("error", reject);
      lockProcess.once("exit", () => reject(new Error(`Lock holder exited before readiness: ${errors}`)));
    });
    assertHolding();
    await probeSharingDenial(powershell, target, join(directory, "probe-rename.pdf"));
    assertHolding();
    expect(await readFile(target), `writer requests before mutation: ${JSON.stringify(writerCalls)}`).toEqual(original);
    await broker.acceptMutation(sessionId, addPageNote(broker.state(sessionId)!, 0,
      { x: 10, y: 10, width: 20, height: 20 }, "Retain this accepted note"));
    assertHolding();
    await coordinator.requestSave(sessionId);
    assertHolding();
    expect(await readFile(target)).toEqual(original);
    expect(broker.saveStatus(sessionId)?.sync.phase).toBe("not-saved");
    const recovered = await new DraftSnapshotStore(join(directory, "recovery", sessionId)).recover();
    expect(recovered?.state.items).toHaveLength(1);
    expect(recovered?.sync.phase).toBe("not-saved");
    assertHolding();
    await releaseHolder();
    expect(lockProcess.exitCode, "lock holder must exit cleanly after explicit release").toBe(0);
    await coordinator.retry(sessionId);
    expect(await readFile(target)).toEqual(reviewed);
    expect(broker.saveStatus(sessionId)?.sync).toMatchObject({ phase: "clean", savedRevision: 1 });
    const { stdout } = await promisify(execFile)(powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encode("(Get-Acl -LiteralPath $env:PLACEKEEPER_LOCK_TARGET).Sddl")],
      { env: { ...process.env, PLACEKEEPER_LOCK_TARGET: target }, windowsHide: true });
    expect(stdout.trim()).toBe(lockedAcl);
  } finally {
    await releaseHolder();
    await broker.quiesceForShutdown();
    await closeWindowsNativeWorker();
    await rm(directory, { recursive: true, force: true });
  }
});
