import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type WindowsNativeRequest =
  | { readonly operation: "verify"; readonly path: string }
  | { readonly operation: "protect"; readonly path: string }
  | { readonly operation: "createPrivateFile"; readonly path: string }
  | { readonly operation: "createPrivateDirectory"; readonly path: string }
  | { readonly operation: "copyAcl"; readonly candidate: string; readonly original: string }
  | { readonly operation: "publish"; readonly candidate: string; readonly target: string; readonly replaceExisting: boolean };
export type WindowsNativeResult = { readonly status: "ok" } | { readonly status: "published" } | { readonly status: "failed"; readonly nativeCode: number };
export class WindowsNativeWorkerError extends Error {
  constructor(message: string, readonly attempted: boolean, readonly uncertain: boolean) { super(message); this.name = "WindowsNativeWorkerError"; }
}

const SCRIPT = String.raw`$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PlacekeeperFilePublication {
 [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
 [return: MarshalAs(UnmanagedType.Bool)]
 public static extern bool MoveFileEx(string existing, string destination, uint flags);
 [StructLayout(LayoutKind.Sequential)]
 private struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle; }
 [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
 [return: MarshalAs(UnmanagedType.Bool)]
 private static extern bool CreateDirectory(string path, ref SecurityAttributes attributes);
 [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
 private static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string path, uint access, uint share, ref SecurityAttributes attributes, uint disposition, uint flags, IntPtr template);
 public static int CreatePrivate(string path, bool directory, byte[] descriptor) {
  IntPtr memory = Marshal.AllocHGlobal(descriptor.Length);
  try {
   Marshal.Copy(descriptor, 0, memory, descriptor.Length);
   SecurityAttributes attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = memory, InheritHandle = false };
   if (directory) return CreateDirectory(path, ref attributes) ? 0 : Marshal.GetLastWin32Error();
   using (var handle = CreateFile(path, 0xC0000000, 0, ref attributes, 1, 0x80, IntPtr.Zero)) {
    return handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
   }
  } finally { Marshal.FreeHGlobal(memory); }
 }
}
'@
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
while ($null -ne ($line=[Console]::In.ReadLine())) {
 $id=$null; $attempted=$false
 try {
  if ([Text.Encoding]::UTF8.GetByteCount($line) -gt 65536) { throw 'Oversized request' }
  $r=$line | ConvertFrom-Json
  $id=$r.id
  if ($id -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid request identity' }
  switch ($r.operation) {
   {$_ -eq 'protect' -or $_ -eq 'verify'} {
    $item=Get-Item -LiteralPath $r.path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point' }
    if ($r.operation -eq 'protect') {
     $acl=if ($item.PSIsContainer) { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }
     $acl.SetOwner($sid)
     $acl.SetAccessRuleProtection($true,$false)
     $rule=if ($item.PSIsContainer) {
      New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,'Allow')
     } else { New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow') }
     $acl.AddAccessRule($rule)
     Set-Acl -LiteralPath $r.path -AclObject $acl
    }
    $a=Get-Acl -LiteralPath $r.path
    if ($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unprotected owner or inheritance' }
    $rules=$a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
    if ($rules.Count -ne 1) { throw 'Unexpected access rules' }
    foreach ($rule in $rules) {
     if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'Non-private ACL' }
    }
    $result=@{status='ok'}
   }
   {$_ -eq 'createPrivateFile' -or $_ -eq 'createPrivateDirectory'} {
    $directory=$r.operation -eq 'createPrivateDirectory'
    $acl=if ($directory) { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true,$false)
    $rule=if ($directory) {
     New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,'Allow')
    } else { New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow') }
    $acl.AddAccessRule($rule)
    $nativeCode=[PlacekeeperFilePublication]::CreatePrivate($r.path,$directory,$acl.GetSecurityDescriptorBinaryForm())
    $result=if ($nativeCode -eq 0) { @{status='ok'} } else { @{status='failed';nativeCode=$nativeCode} }
   }
   'copyAcl' {
    $original=Get-Acl -LiteralPath $r.original
    Set-Acl -LiteralPath $r.candidate -AclObject $original
    $actual=Get-Acl -LiteralPath $r.candidate
    $sections=[System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group
    if ($original.GetSecurityDescriptorSddlForm($sections) -ne $actual.GetSecurityDescriptorSddlForm($sections)) { throw 'Replacement security descriptor was not preserved' }
    $result=@{status='ok'}
   }
   'publish' {
    $flags=if ($r.replaceExisting -eq $false) { [uint32]8 } else { [uint32]9 }
    $attempted=$true
    if ([PlacekeeperFilePublication]::MoveFileEx($r.candidate,$r.target,$flags)) { $result=@{status='published'} }
    else { $result=@{status='failed';nativeCode=[Runtime.InteropServices.Marshal]::GetLastWin32Error()} }
   }
   default { throw 'Unsupported native operation' }
  }
  $reply=@{id=$id;ok=$true;result=$result}
 } catch { $reply=@{id=$id;ok=$false;attempted=$attempted;error='Windows native operation failed'} }
 [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 4))
 [Console]::Out.Flush()
}`;
interface Pending {
  readonly request: WindowsNativeRequest;
  readonly resolve: (result: WindowsNativeResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
interface Worker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pending: Map<string, Pending>;
  readonly closed: Promise<void>;
  readonly resolveClosed: () => void;
  spawned: boolean;
  retiringMessage?: string;
  idle?: ReturnType<typeof setTimeout>;
}
let worker: Worker | undefined;
function reference(current: Worker, active: boolean): void {
  if (active) current.child.ref(); else current.child.unref();
  for (const stream of [current.child.stdin, current.child.stdout, current.child.stderr]) {
    const pipe = stream as unknown as { ref?: () => void; unref?: () => void };
    if (active) pipe.ref?.(); else pipe.unref?.();
  }
}
function retire(current: Worker, message: string): Promise<void> {
  if (current.retiringMessage !== undefined) return current.closed;
  current.retiringMessage = message;
  clearTimeout(current.idle);
  reference(current, true);
  for (const pending of current.pending.values()) clearTimeout(pending.timer);
  // TerminateProcess is asynchronous. Pending operations remain fenced and
  // replacement stays blocked until Node observes the child close boundary.
  try { current.child.kill(); } catch { /* Stay fenced until an observed close. */ }
  return current.closed;
}
function finishRetirement(current: Worker): void {
  for (const pending of current.pending.values()) {
    clearTimeout(pending.timer);
    const uncertain = current.spawned && pending.request.operation === "publish";
    pending.reject(new WindowsNativeWorkerError(current.retiringMessage ?? "Windows native worker closed without a reply", uncertain, uncertain));
  }
  current.pending.clear();
  if (worker === current) worker = undefined;
  current.resolveClosed();
}
function acquireWorker(): Worker {
  if (worker !== undefined) {
    if (worker.retiringMessage !== undefined) throw new WindowsNativeWorkerError("Windows native worker is retiring", false, false);
    clearTimeout(worker.idle); reference(worker, true); return worker;
  }
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined) throw new WindowsNativeWorkerError("Windows system directory is unavailable", false, false);
  const child = spawn(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64"),
  ], { stdio: "pipe", windowsHide: true });
  const closed = Promise.withResolvers<void>();
  const current: Worker = { child, pending: new Map(), spawned: false, closed: closed.promise, resolveClosed: closed.resolve }; worker = current;
  child.once("spawn", () => { current.spawned = true; });
  child.once("error", () => retire(current, "Windows native worker could not start"));
  child.once("exit", () => { void retire(current, "Windows native worker exited without a reply"); });
  child.once("close", () => finishRetirement(current));
  child.stdin.on("error", () => retire(current, "Windows native worker input failed"));
  child.stdout.on("error", () => retire(current, "Windows native worker output failed"));
  child.stderr.on("error", () => retire(current, "Windows native worker diagnostics failed"));
  child.stderr.resume();
  let buffered = Buffer.alloc(0);
  child.stdout.on("data", (bytes: Buffer) => {
    if (current.retiringMessage !== undefined) return;
    buffered = Buffer.concat([buffered, bytes]);
    while (buffered.includes(10)) {
      const end = buffered.indexOf(10);
      if (end > 65536) { retire(current, "Windows native worker response is oversized"); return; }
      const line = buffered.subarray(0, end); buffered = buffered.subarray(end + 1);
      try {
        const reply = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
        const pending = typeof reply.id === "string" ? current.pending.get(reply.id) : undefined;
        if (pending === undefined) throw new Error("Unknown reply");
        if (reply.ok === true) {
          const result = reply.result as WindowsNativeResult;
          if (typeof result !== "object" || result === null || !(pending.request.operation === "publish"
            ? result.status === "published" || (result.status === "failed" && Number.isSafeInteger(result.nativeCode) && result.nativeCode >= 0)
            : result.status === "ok" || ((pending.request.operation === "createPrivateFile" || pending.request.operation === "createPrivateDirectory") && result.status === "failed" && Number.isSafeInteger(result.nativeCode) && result.nativeCode >= 0))) throw new Error("Invalid reply");
          pending.resolve(result);
        } else if (reply.ok === false && typeof reply.attempted === "boolean") {
          const message = pending.request.operation === "verify" || pending.request.operation === "protect"
            ? "Windows private storage permissions could not be verified"
            : pending.request.operation === "copyAcl" ? "Windows replacement security descriptor could not be preserved" : "Windows native publication failed";
          pending.reject(new WindowsNativeWorkerError(message, reply.attempted, reply.attempted && pending.request.operation === "publish"));
        } else throw new Error("Invalid reply");
        clearTimeout(pending.timer); current.pending.delete(reply.id as string);
        if (current.pending.size === 0) {
          reference(current, false);
          current.idle = setTimeout(() => retire(current, "Windows native worker idle retirement"), 30_000);
          current.idle.unref();
        }
      } catch { retire(current, "Windows native worker returned a malformed reply"); return; }
    }
    if (buffered.length > 65536) retire(current, "Windows native worker response is oversized");
  });
  return current;
}
export async function requestWindowsNative(request: WindowsNativeRequest): Promise<WindowsNativeResult> {
  if (process.platform !== "win32") throw new WindowsNativeWorkerError("Windows native worker is only available on Windows", false, false);
  const id = randomUUID(); const serialized = `${JSON.stringify({ ...request, id })}\n`;
  const paths = "path" in request ? [request.path]
    : request.operation === "copyAcl" ? [request.candidate, request.original] : [request.candidate, request.target];
  if (paths.some((path) => typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) || Buffer.byteLength(serialized) > 65536) throw new WindowsNativeWorkerError("Invalid Windows native request", false, false);
  if (request.operation === "publish" && resolve(dirname(request.candidate)) !== resolve(dirname(request.target))) throw new WindowsNativeWorkerError("Publication requires sibling paths", false, false);
  const current = acquireWorker();
  if (current.pending.size >= 256) throw new WindowsNativeWorkerError("Windows native worker is busy", false, false);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => retire(current, "Windows native worker timed out"), 30_000);
    current.pending.set(id, { request, resolve, reject, timer });
    current.child.stdin.write(serialized, (error) => { if (error) retire(current, "Windows native worker write failed"); });
  });
}
export async function closeWindowsNativeWorker(): Promise<void> { if (worker !== undefined) await retire(worker, "Windows native worker closed"); }
