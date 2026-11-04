import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
const execute=promisify(execFile);
const ownedKey='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Placekeeper';
const openWithKey='HKCU\\Software\\Classes\\Applications\\PlacekeeperDesktop.exe';
export async function registerWindowsInstallation(destination, writeShortcut, invoke=execute) {
  const executable=join(destination,'PlacekeeperDesktop.exe');
  const add=(key,name,type,value)=>invoke('reg.exe',['add',key,...(name?['/v',name]:['/ve']),'/t',type,'/d',value,'/f'],{windowsHide:true});
  const shortcut=join(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/Placekeeper.lnk');
  if (!writeShortcut(shortcut,{target:executable,description:'Placekeeper PDF review'})) throw Error('Cannot create Placekeeper Start menu shortcut');
  await invoke(executable,['--placekeeper-register-protocols'],{timeout:30_000});
  await add(openWithKey+'\\shell\\open\\command','','REG_SZ',`"${executable}" "%1"`);
  await add(openWithKey+'\\SupportedTypes','.pdf','REG_SZ','');
  await add(ownedKey,'DisplayName','REG_SZ','Placekeeper');
  await add(ownedKey,'InstallLocation','REG_SZ',destination);
  await add(ownedKey,'UninstallString','REG_SZ',`"${join(destination,'Uninstall.exe')}"`);
  await add(ownedKey,'NoModify','REG_DWORD','1'); await add(ownedKey,'NoRepair','REG_DWORD','1');
  await writeFile(join(destination,'installation-registration.json'),JSON.stringify({version:1,executable,shortcut,shortcutSha256:createHash('sha256').update(await readFile(shortcut)).digest('hex')})+'\n',{mode:0o600});
}
/** Runs from the separately staged runtime after guarded retirement. */
export async function unregisterWindowsInstallation(destination, invoke=execute) {
  const executable=join(destination,'PlacekeeperDesktop.exe');
  const record=JSON.parse(await readFile(join(destination,'installation-registration.json'),'utf8'));
  const expectedShortcut=join(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/Placekeeper.lnk');
  if(record.version!==1||record.executable!==executable||record.shortcut!==expectedShortcut) throw Error('Installation registration ownership is uncertain; retain files for manual cleanup');
  const retained=[];
  const query=async(key,name)=>invoke('reg.exe',['query',key,...(name?['/v',name]:['/ve'])],{windowsHide:true}).then(result=>{
    const row=result.stdout.split(/\r?\n/u).find(line=>/\sREG_[A-Z0-9_]+(?:\s|$)/u.test(line));
    const value=row?.match(/\s(REG_[A-Z0-9_]+)(?:\s+(.*))?$/u);
    return value?{type:value[1],value:value[2]??''}:undefined;
  },error=>{if(error.code===1)return undefined;throw error;});
  const removeMatching=async(key,commandKey,name,expected)=>{
    const actual=await query(commandKey,name);
    if(actual?.type==='REG_SZ'&&actual.value===expected)await invoke('reg.exe',['delete',key,'/f'],{windowsHide:true});
    else if(actual!==undefined)retained.push(key);
  };
  for(const scheme of ['placekeeper','placekeeper-navigation']) {
    const key='HKCU\\Software\\Classes\\'+scheme;
    await removeMatching(key,key+'\\shell\\open\\command','',`"${executable}" "%1"`);
  }
  await removeMatching(openWithKey,openWithKey+'\\shell\\open\\command','',`"${executable}" "%1"`);
  await removeMatching(ownedKey,ownedKey,'InstallLocation',destination);
  const shortcut=await lstat(expectedShortcut).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(shortcut) {
    if(shortcut.isFile()&&!shortcut.isSymbolicLink()&&/^[a-f0-9]{64}$/u.test(record.shortcutSha256??'')&&createHash('sha256').update(await readFile(expectedShortcut)).digest('hex')===record.shortcutSha256)await unlink(expectedShortcut);
    else retained.push(expectedShortcut);
  }
  return retained;
}
