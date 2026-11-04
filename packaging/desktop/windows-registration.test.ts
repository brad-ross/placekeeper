import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { unregisterWindowsInstallation } from './windows-registration.mjs';

for(const edited of [false,true])it(`preserves edited registration commands and ${edited?'edited':'removes unchanged'} shortcut bytes`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'pk-uninstall-ownership-'));
  const previous=process.env.APPDATA;process.env.APPDATA=join(root,'roaming');
  try {
    const destination=join(root,'installed');await mkdir(destination);
    const shortcut=join(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/Placekeeper.lnk');await mkdir(join(shortcut,'..'),{recursive:true});
    const original='owned shortcut bytes';await writeFile(shortcut,edited?'user-edited shortcut':original);
    const executable=join(destination,'PlacekeeperDesktop.exe');
    await writeFile(join(destination,'installation-registration.json'),JSON.stringify({version:1,executable,shortcut,shortcutSha256:createHash('sha256').update(original).digest('hex')}));
    const deleted: string[]=[];
    // Registry query output is the external Windows format. Actual shortcut
    // bytes and removal are exercised on disk; native registry proof remains
    // required on Windows and these fixtures do not qualify an installer.
    const retained=await unregisterWindowsInstallation(destination,async(_command:string,args:string[])=>{
      const key=args[1]!;
      if(args[0]==='delete'){deleted.push(key);return {stdout:''};}
      const value=key.includes('Uninstall')?destination:key.includes('placekeeper-navigation')?`"${executable}" "%1"`:key.includes('Applications')?`"${executable}" "%1" --user-added`:`wrapper "${executable}" "%1"`;
      return {stdout:`\r\n${key}\r\n    ${args[2]==='/v'?'InstallLocation':'(Default)'}    REG_SZ    ${value}\r\n`};
    });
    expect(deleted).toEqual(['HKCU\\Software\\Classes\\placekeeper-navigation','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Placekeeper']);
    expect(retained).toContain('HKCU\\Software\\Classes\\placekeeper');expect(retained).toContain('HKCU\\Software\\Classes\\Applications\\PlacekeeperDesktop.exe');
    if(edited){expect(await readFile(shortcut,'utf8')).toBe('user-edited shortcut');expect(retained).toContain(shortcut);}
    else await expect(readFile(shortcut)).rejects.toMatchObject({code:'ENOENT'});
  } finally {if(previous===undefined)delete process.env.APPDATA;else process.env.APPDATA=previous;await rm(root,{recursive:true,force:true});}
});
