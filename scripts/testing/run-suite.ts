import { spawn } from "node:child_process";
import { suiteCommand } from "./suites.js";

const [name, ...args] = process.argv.slice(2);
if (!name) throw new Error('A test suite name is required.');
const command = suiteCommand(name);

if (process.platform !== 'win32' && typeof process.execve === 'function') {
  // Replace the adapter with the same shell used by package scripts: no extra
  // process swallows a signal or rewrites a child exit status. Like pnpm, append
  // user arguments to the final stage, leaving prerequisite filters untouched.
  const env = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ));
  process.execve('/bin/sh', ['sh', '-c', `${command} "$@"`, name, ...args], env);
} else {
  // Node's execve is unavailable on Windows; let its platform shell adapter
  // retain package-script wildcard and environment syntax.
  const quotedArgs = args.map((arg) => {
    // Quote Windows argv backslashes, then escape cmd.exe metacharacters.
    const quoted = '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
    return quoted.replace(/([()%!^"<>&|;, *?])/g, '^$1');
  });
  const child = process.platform === 'win32'
    ? spawn([command, ...quotedArgs].join(' '), { shell: true, stdio: 'inherit' })
    : spawn('/bin/sh', ['-c', `${command} "$@"`, name, ...args], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', (error) => { throw error; });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    }
    else process.exit(code ?? 1);
  });
}
