/** Just enough ZIP for plugin archives: UTF-8 text files, deflated or stored, no ZIP64 or encryption.
 * Uses CompressionStream, so the same code runs in extension pages and in Node. */
export class ZipError extends Error { constructor(message: string) { super(message); this.name = 'ZipError'; } }

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity) {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    // Stop inflating as soon as an entry outgrows what its header declared.
    if (size > limit) { await reader.cancel(); throw new ZipError('An archive entry is larger than its header says.'); }
    chunks.push(value);
  }
  const out = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

function dosDateTime(date: Date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** Write text files to a ZIP archive, keyed by their path inside it. */
export async function createZip(files: Record<string, string>, modified = new Date()): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const { time, day } = dosDateTime(modified);
  const locals: Uint8Array[] = []; const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = encoder.encode(path); const data = encoder.encode(text);
    const compressed = await transform(data, new CompressionStream('deflate-raw'));
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length); const head = new DataView(local.buffer);
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); head.setUint16(8, 8, true);
    head.setUint16(10, time, true); head.setUint16(12, day, true); head.setUint32(14, crc, true);
    head.setUint32(18, compressed.length, true); head.setUint32(22, data.length, true); head.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length); const entry = new DataView(central.buffer);
    entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true); entry.setUint16(8, 0x0800, true); entry.setUint16(10, 8, true);
    entry.setUint16(12, time, true); entry.setUint16(14, day, true); entry.setUint32(16, crc, true);
    entry.setUint32(20, compressed.length, true); entry.setUint32(24, data.length, true); entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, compressed); centrals.push(central);
    offset += local.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22); const tail = new DataView(end.buffer);
  tail.setUint32(0, 0x06054b50, true); tail.setUint16(8, centrals.length, true); tail.setUint16(10, centrals.length, true);
  tail.setUint32(12, centralSize, true); tail.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length); let at = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.length; }
  return out;
}

/** Read every file in a ZIP archive as UTF-8 text. Directory entries are skipped. */
export async function readZip(bytes: Uint8Array, limits: { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number }): Promise<Record<string, string>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) if (view.getUint32(at, true) === 0x06054b50) { end = at; break; }
  if (end < 0) throw new ZipError('This file is not a ZIP archive.');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count > limits.maxEntries) throw new ZipError(`The archive has ${count} entries; at most ${limits.maxEntries} are allowed.`);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const files: Record<string, string> = {}; let total = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new ZipError('The archive’s directory is damaged.');
    const flags = view.getUint16(at + 8, true); const method = view.getUint16(at + 10, true); const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true); const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true); const extraLength = view.getUint16(at + 30, true); const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    let name: string;
    try { name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)); } catch { throw new ZipError('An archive entry has an unreadable name.'); }
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new ZipError(`${name} is encrypted.`);
    if (method !== 0 && method !== 8) throw new ZipError(`${name} uses an unsupported compression method.`);
    if (size > limits.maxEntryBytes) throw new ZipError(`${name} is too large.`);
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError('The archive is too large once unpacked.');
    if (localAt + 30 > bytes.length || view.getUint32(localAt, true) !== 0x04034b50) throw new ZipError(`${name} is damaged.`);
    const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    if (dataAt + compressedSize > bytes.length) throw new ZipError(`${name} is truncated.`);
    const raw = bytes.subarray(dataAt, dataAt + compressedSize);
    let data: Uint8Array;
    try { data = method === 0 ? raw : await transform(raw, new DecompressionStream('deflate-raw'), size); }
    catch (error) { throw error instanceof ZipError ? error : new ZipError(`${name} could not be decompressed.`); }
    if (data.length !== size || crc32(data) !== crc) throw new ZipError(`${name} is corrupt.`);
    if (name in files) throw new ZipError(`${name} appears twice in the archive.`);
    try { files[name] = decoder.decode(data); } catch { throw new ZipError(`${name} is not a text file.`); }
  }
  return files;
}
