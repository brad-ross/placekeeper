import { expect, it } from 'vitest';
import { join } from 'node:path';
import { assertSandboxMount, linuxSelectionPath, validateImmutableRuntime } from './linux-dispatcher.mjs';

it('selects each user independently while keeping the runtime outside user state',()=>{
  expect(linuxSelectionPath({HOME:'/home/first'})).toBe(join('/home/first', '.local', 'state', 'placekeeper', 'installer', 'selected-runtime.json'));
  expect(linuxSelectionPath({HOME:'/home/second',XDG_STATE_HOME:'/state/second'})).toBe(join('/state/second', 'placekeeper', 'installer', 'selected-runtime.json'));
});
it('blocks the effective noexec or nosuid mount without disabling the sandbox',()=>{
  const root='20 1 8:1 / / rw,relatime - ext4 /dev/root rw\n';
  expect(()=>assertSandboxMount(root,'/opt/placekeeper/runtimes/id/chrome-sandbox')).not.toThrow();
  for(const flag of ['noexec','nosuid']) expect(()=>assertSandboxMount(root+`21 20 8:2 / /opt rw,${flag} - ext4 /dev/other rw\n`,'/opt/placekeeper/runtimes/id/chrome-sandbox')).toThrow('do not disable the sandbox');
  expect(()=>assertSandboxMount('', '/opt/placekeeper/chrome-sandbox')).toThrow('Cannot verify');
});
it('refuses user-owned or redirected candidate locations before considering activation',async()=>{
  await expect(validateImmutableRuntime('/home/reader/.local/placekeeper/resources/desktop')).rejects.toThrow('Unexpected immutable runtime');
});
