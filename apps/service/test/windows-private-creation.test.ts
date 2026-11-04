import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createPrivateFile, ensurePrivateDirectory, verifyPrivatePath, writePrivateFile } from "../src/platform/private-storage.js";
import { closeWindowsNativeWorker } from "../src/platform/windows-native-worker.js";
import { windowsPowerShellScript } from "../src/platform/windows-powershell.js";
import { WINDOWS_REPLACEMENT_SECURITY_SOURCE } from "../src/platform/windows-security-descriptor.js";
const roots: string[] = [];
afterEach(async () => {
  await closeWindowsNativeWorker();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.runIf(process.platform === "win32")("compares replacement descriptors ignoring only the file auto-inherited marker", async () => {
  const script = windowsPowerShellScript(String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${WINDOWS_REPLACEMENT_SECURITY_SOURCE}
'@
function Serialize($descriptor) {
 $bytes=New-Object byte[]($descriptor.BinaryLength)
 $descriptor.GetBinaryForm($bytes,0)
 return ,$bytes
}
function Bytes($sddl,$flags=0) {
 $raw=New-Object System.Security.AccessControl.RawSecurityDescriptor($sddl)
 $raw.SetFlags($raw.ControlFlags -bor $flags)
 return ,(Serialize $raw)
}
$base='O:SYG:BAD:(A;;FA;;;SY)(A;;FR;;;BA)'
$expected=Bytes $base
$marked=Bytes $base 0x400
$markedBefore=[Convert]::ToBase64String($marked)
$raw=New-Object System.Security.AccessControl.RawSecurityDescriptor($expected,0)
$absent=[System.Security.AccessControl.RawSecurityDescriptor]::new([System.Security.AccessControl.ControlFlags]::None,$raw.Owner,$raw.Group,$null,$null)
$nullDacl=[System.Security.AccessControl.RawSecurityDescriptor]::new([System.Security.AccessControl.ControlFlags]::DiscretionaryAclPresent,$raw.Owner,$raw.Group,$null,$null)
$results=@{
 identical=[PlacekeeperReplacementSecurity]::Equivalent($expected,$expected)
 autoInherited=[PlacekeeperReplacementSecurity]::Equivalent($expected,$marked)
 rights=[PlacekeeperReplacementSecurity]::Equivalent($expected,(Bytes 'O:SYG:BAD:(A;;FR;;;SY)(A;;FR;;;BA)'))
 principal=[PlacekeeperReplacementSecurity]::Equivalent($expected,(Bytes 'O:SYG:BAD:(A;;FA;;;BU)(A;;FR;;;BA)'))
 order=[PlacekeeperReplacementSecurity]::Equivalent($expected,(Bytes 'O:SYG:BAD:(A;;FR;;;BA)(A;;FA;;;SY)'))
 aceFlags=[PlacekeeperReplacementSecurity]::Equivalent($expected,(Bytes 'O:SYG:BAD:(A;ID;FA;;;SY)(A;;FR;;;BA)'))
 protected=[PlacekeeperReplacementSecurity]::Equivalent($expected,(Bytes $base 0x1000))
 inheritRequest=[PlacekeeperReplacementSecurity]::Equivalent($expected,(Bytes $base 0x100))
 defaulted=[PlacekeeperReplacementSecurity]::Equivalent($expected,(Bytes $base 0x8))
 owner=[PlacekeeperReplacementSecurity]::Equivalent($expected,(Bytes 'O:BAG:BAD:(A;;FA;;;SY)(A;;FR;;;BA)'))
 group=[PlacekeeperReplacementSecurity]::Equivalent($expected,(Bytes 'O:SYG:SYD:(A;;FA;;;SY)(A;;FR;;;BA)'))
 present=[PlacekeeperReplacementSecurity]::Equivalent((Serialize $absent),(Serialize $nullDacl))
 nullVsEmpty=[PlacekeeperReplacementSecurity]::Equivalent((Serialize $nullDacl),(Bytes 'O:SYG:BAD:'))
 inputUnchanged=([Convert]::ToBase64String($marked) -eq $markedBefore)
}
[Console]::Out.Write(($results | ConvertTo-Json -Compress))
`);
  const { stdout } = await promisify(execFile)(join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
  expect(JSON.parse(stdout)).toEqual({ identical: true, autoInherited: true, rights: false, principal: false, order: false, aceFlags: false,
    protected: false, inheritRequest: false, defaulted: false, owner: false, group: false, present: false, nullVsEmpty: false, inputUnchanged: true });
}, 15_000);
it.runIf(process.platform === "win32")("verifies private storage despite incompatible inherited PowerShell module paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-private-modules-")); roots.push(root);
  const modules = join(root, "modules");
  const security = join(modules, "Microsoft.PowerShell.Security");
  await mkdir(security, { recursive: true });
  await writeFile(join(security, "Microsoft.PowerShell.Security.psd1"), `@{
ModuleVersion = '99.0'
RootModule = 'Microsoft.PowerShell.Security.psm1'
FunctionsToExport = @('Get-Acl', 'Set-Acl')
}`);
  await writeFile(join(security, "Microsoft.PowerShell.Security.psm1"), "throw 'Incompatible inherited security module'");
  // PowerShell 7 passes its module path through intermediate processes such as
  // Node. Prove this path breaks ordinary Windows PowerShell module discovery.
  vi.stubEnv("PSModulePath", modules);
  const script = "$ErrorActionPreference='Stop'; Get-Acl -LiteralPath $env:PLACEKEEPER_TEST_PATH";
  await expect(promisify(execFile)(join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { env: { ...process.env, PLACEKEEPER_TEST_PATH: root }, windowsHide: true })).rejects.toMatchObject({
      stderr: expect.stringContaining("Microsoft.PowerShell.Security"),
    });
  const directory = join(root, "private");
  await ensurePrivateDirectory(directory);
  await verifyPrivatePath(directory, "directory");
  const file = join(directory, "secret");
  await createPrivateFile(file);
  await verifyPrivatePath(file, "file");
}, 15_000);
it.runIf(process.platform === "win32")("creates private Windows files and inheritable directories without altering existing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-private-create-")); roots.push(root);
  const directory = join(root, "private"); await ensurePrivateDirectory(directory);
  await verifyPrivatePath(directory, "directory");
  const file = join(directory, "secret"); await createPrivateFile(file);
  await verifyPrivatePath(file, "file"); await writeFile(file, "original");
  await expect(createPrivateFile(file)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(file, "utf8")).toBe("original");
  const inherited = join(directory, "inherited"); await writeFile(inherited, "inherited private bytes");
  // An elevated token may assign Administrators as the default owner. Inspect
  // the actual descriptor independently: DACL inheritance does not imply that
  // an ordinary Node-created file also has the required private owner.
  const script = windowsPowerShellScript(`
$ErrorActionPreference='Stop'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=Get-Acl -LiteralPath $env:PLACEKEEPER_TEST_PATH
$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
 @{ currentUser=($_.IdentityReference.Value -eq $sid.Value); rights=[int]$_.FileSystemRights; type=[int]$_.AccessControlType; inherited=$_.IsInherited; inheritance=[int]$_.InheritanceFlags; propagation=[int]$_.PropagationFlags }
})
[Console]::Out.Write((@{ ownerIsCurrentUser=($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value); rules=$rules } | ConvertTo-Json -Compress -Depth 4))
`);
  const { stdout } = await promisify(execFile)(join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { env: { ...process.env, PLACEKEEPER_TEST_PATH: inherited }, windowsHide: true });
  const descriptor = JSON.parse(stdout) as { ownerIsCurrentUser: boolean; rules: unknown[] };
  expect(descriptor.rules).toEqual([{ currentUser: true, rights: 0x1f01ff, type: 0, inherited: true, inheritance: 0, propagation: 0 }]);
  expect(typeof descriptor.ownerIsCurrentUser).toBe("boolean");
  if (descriptor.ownerIsCurrentUser) await expect(verifyPrivatePath(inherited, "file")).resolves.toBeUndefined();
  else await expect(verifyPrivatePath(inherited, "file")).rejects.toMatchObject({ reason: "owner-mismatch" });
  const streamed = join(directory, "streamed");
  await writePrivateFile(streamed, (async function* () { yield Buffer.from("one"); yield Buffer.from("two"); })());
  expect(await readFile(streamed, "utf8")).toBe("onetwo"); await verifyPrivatePath(streamed, "file");
});
it.runIf(process.platform === "win32")("refuses an existing exposed directory without repairing its ACL", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-private-existing-")); roots.push(root);
  const execute = promisify(execFile);
  await execute(join(process.env.SystemRoot!, "System32", "icacls.exe"), [root, "/grant", "*S-1-1-0:(OI)(CI)R"], { windowsHide: true });
  async function descriptor(): Promise<string> {
    const script = "[Console]::Out.Write((Get-Acl -LiteralPath $env:PLACEKEEPER_TEST_PATH).Sddl)";
    return (await execute(join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsPowerShellScript(script), "utf16le").toString("base64")], { env: { ...process.env, PLACEKEEPER_TEST_PATH: root }, windowsHide: true })).stdout;
  }
  const before = await descriptor();
  await expect(ensurePrivateDirectory(root)).rejects.toThrow();
  expect(await descriptor()).toBe(before);
});
