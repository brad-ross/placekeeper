import { afterEach, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('electron',()=>({
  app:{isPackaged:true,setName:vi.fn(),setPath:vi.fn(),on:vi.fn(),quit:vi.fn(),requestSingleInstanceLock:vi.fn(),hasSingleInstanceLock:vi.fn(),whenReady:vi.fn(()=>new Promise(()=>{}))},
  protocol:{registerSchemesAsPrivileged:vi.fn()},BrowserWindow:class {},dialog:{},ipcMain:{},session:{},clipboard:{},screen:{},shell:{},
}));
import { app } from 'electron';
const argv=process.argv;
afterEach(async()=>{
  process.argv=argv;vi.unstubAllEnvs();
  for(const [,profile] of vi.mocked(app.setPath).mock.calls)await rm(profile,{recursive:true,force:true});
});
it('routes real isolated installer arguments past ordinary shell smoke parsing without taking the review lock',async()=>{
  vi.stubEnv('PLACEKEEPER_STARTUP_REQUEST',undefined);
  process.argv=[process.execPath,'--placekeeper-install',join(tmpdir(),'candidate.app'),'--destination',join(tmpdir(),'installed.app'),'--http-port','63828','--isolated-test-root',join(tmpdir(),'installer-state')];
  // Readiness remains pending, so this exercises actual main-module routing
  // without presenting or approving any native dialog.
  await expect(import('../src/main.js')).resolves.toBeDefined();
  expect(app.whenReady).toHaveBeenCalledOnce();
  expect(app.requestSingleInstanceLock).not.toHaveBeenCalled();
  expect(app.setPath).toHaveBeenCalledTimes(1);
  expect(vi.mocked(app.setPath).mock.calls[0]?.[0]).toBe('userData');
});
