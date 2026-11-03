import { test, expect } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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

// This exercises a real Windows sharing denial, not a mocked rename errno.
// The writer is deterministic so publication/recovery is isolated from PDF IO.
test("a Windows sharing lock preserves original bytes and accepted recovery, then explicit retry saves with its ACL", async () => {
  test.skip(process.platform !== "win32", "Requires real Windows file sharing and ACL semantics");
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "placekeeper-sharing-"));
  const target = join(directory, "paper.pdf");
  const original = Buffer.from("%PDF-1.7\noriginal\n%%EOF");
  const reviewed = Buffer.from("%PDF-1.7\nreviewed note\n%%EOF");
  await writeFile(target, original);
  const broker = new SessionBroker({ recoveryRoot: join(directory, "recovery"), portableReader: async () => [] });
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let holder: ReturnType<typeof spawn> | undefined;
  try {
    const opened = await broker.openReview({ pdfPath: target });
    if (opened.kind !== "opened") throw new Error("Expected fresh review");
    const sessionId = opened.launch.sessionId;
    const writer: PdfWriter = { write: async request => ({
      pdfBytes: reviewed,
      evidence: { backend: "embedpdf", backendVersion: "test", originalSha256: request.sourceSha256,
        outputSha256: sha(reviewed), pageCount: 1, structurallyValid: true,
        preexistingAnnotationIds: [], annotations: [] },
    }) };
    const coordinator = new PdfSaveCoordinator({ broker, writer,
      verify: async ({ annotations }) => ({ pageCount: 1, annotationIds: annotations.map(item => item.id) }) });
    await coordinator.chooseOriginal(sessionId);
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
try { [Console]::ReadLine() | Out-Null } finally { $handle.Dispose() }
`)], { env: { ...process.env, PLACEKEEPER_LOCK_TARGET: target }, windowsHide: true });
    const lockProcess = holder;
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
    await broker.acceptMutation(sessionId, addPageNote(broker.state(sessionId)!, 0,
      { x: 10, y: 10, width: 20, height: 20 }, "Retain this accepted note"));
    await coordinator.requestSave(sessionId);
    expect(await readFile(target)).toEqual(original);
    expect(broker.saveStatus(sessionId)?.sync.phase).toBe("not-saved");
    const recovered = await new DraftSnapshotStore(join(directory, "recovery", sessionId)).recover();
    expect(recovered?.state.items).toHaveLength(1);
    expect(recovered?.sync.phase).toBe("not-saved");
    const exited = once(lockProcess, "exit");
    lockProcess.stdin!.end("\n");
    await exited;
    holder = undefined;
    await coordinator.retry(sessionId);
    expect(await readFile(target)).toEqual(reviewed);
    expect(broker.saveStatus(sessionId)?.sync).toMatchObject({ phase: "clean", savedRevision: 1 });
    const { stdout } = await promisify(execFile)(powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encode("(Get-Acl -LiteralPath $env:PLACEKEEPER_LOCK_TARGET).Sddl")],
      { env: { ...process.env, PLACEKEEPER_LOCK_TARGET: target }, windowsHide: true });
    expect(stdout.trim()).toBe(lockedAcl);
  } finally {
    if (holder !== undefined) {
      if (holder.exitCode === null && holder.signalCode === null) {
        const exited = once(holder, "exit");
        holder.stdin?.end("\n");
        await exited;
      }
    }
    await broker.quiesceForShutdown();
    await closeWindowsNativeWorker();
    await rm(directory, { recursive: true, force: true });
  }
});
