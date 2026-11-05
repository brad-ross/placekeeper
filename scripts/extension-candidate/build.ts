import { packageCandidate } from './package.js';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--opaque-resource') || args.length > 1) throw new Error('Usage: build.ts [--opaque-resource]');
const output = await packageCandidate({ route: args.includes('--opaque-resource') ? 'opaque-resource' : 'host-selected' });
console.log(`Candidate: ${output}\nStart isolated daemon: ${process.execPath} ${output}/start-daemon.mjs\nBuild metadata: ${output}/build.json`);
