import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { crc32 } from 'node:zlib';
/** Deterministic stored ZIP, sufficient for the modest bundled VSIX. No host
 * archiver, shell, external package, timestamps, or zip64 extensions. */
export async function writeZip(output, root, entries) {
  const local = [], central = [];
  let offset = 0;
  if (entries.length > 65535 || new Set(entries).size !== entries.length) throw new Error('Invalid ZIP entry inventory');
  for (const entry of entries) {
    const path = resolve(root, entry), suffix = relative(root, path);
    if (!suffix || suffix.startsWith('..') || isAbsolute(suffix) || entry.includes('\\')) throw new Error('Invalid ZIP entry path');
    const directory = entry.endsWith('/');
    const name = Buffer.from(entry, 'utf8');
    const bytes = directory ? Buffer.alloc(0) : await readFile(path);
    if (name.length > 65535 || bytes.length > 0xffffffff || offset > 0xffffffff) throw new Error('ZIP requires zip64');
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x2821, 12); // 2000-01-01; UTC time is zero.
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(0x2821, 14); record.writeUInt32LE(crc, 16); record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((directory ? 0o40755 : 0o100644) << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  if (directory.length > 0xffffffff || offset > 0xffffffff) throw new Error('ZIP requires zip64');
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  await writeFile(output, Buffer.concat([...local, directory, end]));
}
