import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('electron',()=>({app:{whenReady:vi.fn(async()=>{}),quit:vi.fn(),exit:vi.fn()},dialog:{showMessageBox:vi.fn(),showErrorBox:vi.fn()},shell:{}}));
import { app, dialog } from 'electron';
import { runInstallerUI } from '../src/installer-ui.js';
const temporary:string[]=[];
afterEach(async()=>{vi.clearAllMocks();await Promise.all(temporary.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture(fail:boolean) {
  const root=await mkdtemp(join(tmpdir(),'pk-installer-ui-'));temporary.push(root);
  const candidate=join(root,'candidate'),profile=join(root,'profile'),destination=join(root,'installed');
  const installer=join(candidate,process.platform==='darwin'?'Contents/Resources/desktop/installer':'resources/desktop/installer');
  await mkdir(installer,{recursive:true});await mkdir(profile);await writeFile(join(profile,'temporary-state'),'installer only');
  const failure={userMessage:'Active reviews need to be saved.\n\nSave the PDF and close the old app, then retry.'};
  await writeFile(join(installer,'installer-entry.mjs'),`export async function runInstaller(request){${fail?`throw Object.assign(new Error('full stderr Warning and coordinator JSON diagnostics'),${JSON.stringify(failure)});`:`return {destination:request.destination};`}}export function resolveInstallLayout(){return {destination:${JSON.stringify(destination)}};}`);
  return {candidate,profile,destination,root};
}
it('cleans its temporary profile then explicitly exits nonzero after presenting concise failure guidance',async()=>{
  const fixtureRoot=await fixture(true);
  vi.mocked(dialog.showMessageBox).mockResolvedValue({response:1,checkboxChecked:false});
  vi.mocked(app.exit).mockImplementation(()=>{expect(existsSync(fixtureRoot.profile)).toBe(false);});
  await runInstallerUI({candidate:fixtureRoot.candidate,destination:fixtureRoot.destination,immutable:false,uninstall:false,isolatedRoot:join(fixtureRoot.root,'state'),port:63828},fixtureRoot.profile);
  expect(app.exit).toHaveBeenCalledWith(2);expect(app.quit).not.toHaveBeenCalled();
  expect(dialog.showErrorBox).toHaveBeenCalledWith('Placekeeper installation stopped','Active reviews need to be saved.\n\nSave the PDF and close the old app, then retry.');
});
it.each([0,1])('preserves initial cancel or successful completion status for initial choice %s',async response=>{
  const fixtureRoot=await fixture(false);
  vi.mocked(dialog.showMessageBox).mockResolvedValue({response,checkboxChecked:false});
  await runInstallerUI({candidate:fixtureRoot.candidate,destination:fixtureRoot.destination,immutable:false,uninstall:false,isolatedRoot:join(fixtureRoot.root,'state'),port:63828},fixtureRoot.profile);
  expect(app.exit).not.toHaveBeenCalled();expect(app.quit).toHaveBeenCalledOnce();expect(existsSync(fixtureRoot.profile)).toBe(false);
});
