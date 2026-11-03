/** Resolve native helper cmdlets only from the launched Windows PowerShell runtime.
 * PowerShell 7 module paths inherited through Node can contain incompatible
 * versions of the Security and Utility modules, even with -NoProfile.
 */
export function windowsPowerShellScript(script: string): string {
  return `$env:PSModulePath=$PSHOME+'\\Modules'\n${script}`;
}
