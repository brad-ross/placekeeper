// A real command-adapter process. This deliberately does not claim editor UI evidence.
const fs = require('node:fs');
const [record, file, line, column] = process.argv.slice(2);
fs.appendFileSync(record, JSON.stringify({ pid: process.pid, file, line: Number(line), column: Number(column) }) + '\n');
