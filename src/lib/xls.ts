/**
 * A minimal reader for the legacy .xls files UFD publishes.
 *
 * UFD ships its weekly top 20 only as BIFF8 workbooks inside OLE2 compound
 * files — no CSV, no xlsx. The npm packages that read that format are either
 * unmaintained with open advisories or no longer distributed through npm, and
 * this project otherwise has no runtime dependencies at all. The format is
 * frozen and the files are small and uniform, so reading them directly is both
 * safer and smaller than pulling in a general-purpose spreadsheet library.
 *
 * Only what these files actually contain is implemented: one sheet, shared
 * strings, numbers, and RK-encoded numbers. Anything else is ignored rather
 * than guessed at.
 */

export type Cell = string | number | null;
export type Sheet = Cell[][];

// --- OLE2 compound file ----------------------------------------------------

const SECTOR_SIZE_OFFSET = 30;
const DIR_START_OFFSET = 48;
const DIFAT_OFFSET = 76;
const DIFAT_HEADER_ENTRIES = 109;
const FREE_SECT = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;
const DIR_ENTRY_SIZE = 128;

function readChain(view: DataView, fat: number[], start: number, sectorSize: number): Uint8Array {
  const parts: Uint8Array[] = [];
  const seen = new Set<number>();
  let sector = start;
  while (sector !== END_OF_CHAIN && sector !== FREE_SECT && sector < fat.length) {
    // A corrupt FAT could otherwise loop forever.
    if (seen.has(sector)) break;
    seen.add(sector);
    const offset = (sector + 1) * sectorSize;
    parts.push(new Uint8Array(view.buffer, view.byteOffset + offset, sectorSize));
    sector = fat[sector];
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Pull the Workbook stream out of the compound file. */
function findWorkbookStream(buf: Uint8Array): Uint8Array {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const signature = buf.subarray(0, 8);
  const expected = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (!expected.every((b, i) => signature[i] === b)) {
    throw new Error("not an OLE2 compound file");
  }

  const sectorSize = 1 << view.getUint16(SECTOR_SIZE_OFFSET, true);

  // The first 109 FAT sector numbers live in the header, which covers files far
  // larger than these; a workbook needing the DIFAT chain would be ~7 MB.
  const fat: number[] = [];
  for (let i = 0; i < DIFAT_HEADER_ENTRIES; i++) {
    const fatSector = view.getUint32(DIFAT_OFFSET + i * 4, true);
    if (fatSector === FREE_SECT) break;
    const base = (fatSector + 1) * sectorSize;
    for (let j = 0; j < sectorSize / 4; j++) fat.push(view.getUint32(base + j * 4, true));
  }

  const directory = readChain(view, fat, view.getUint32(DIR_START_OFFSET, true), sectorSize);
  const dirView = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);

  for (let entry = 0; entry * DIR_ENTRY_SIZE < directory.length; entry++) {
    const base = entry * DIR_ENTRY_SIZE;
    const nameLength = dirView.getUint16(base + 64, true);
    if (nameLength < 4) continue;
    let name = "";
    for (let i = 0; i < nameLength / 2 - 1; i++) {
      name += String.fromCharCode(dirView.getUint16(base + i * 2, true));
    }
    if (name !== "Workbook" && name !== "Book") continue;

    const size = dirView.getUint32(base + 120, true);
    const stream = readChain(view, fat, dirView.getUint32(base + 116, true), sectorSize);
    // The header said the mini-stream cutoff is 4096; these workbooks are well
    // above it, so the stream always lives in the main FAT.
    if (size < 4096) throw new Error("workbook stored in the mini-stream, which is not supported");
    return stream.subarray(0, size);
  }
  throw new Error("no Workbook stream in the compound file");
}

// --- BIFF8 records ---------------------------------------------------------

const REC_BOF = 0x0809;
const REC_EOF = 0x000a;
const REC_SST = 0x00fc;
const REC_CONTINUE = 0x003c;
const REC_LABELSST = 0x00fd;
const REC_NUMBER = 0x0203;
const REC_RK = 0x027e;
const REC_MULRK = 0x00bd;

/**
 * RK packs a number into 32 bits: two flag bits plus either a 30-bit signed
 * integer or the top 30 bits of an IEEE double.
 */
function decodeRk(rk: number): number {
  let value: number;
  if (rk & 0x02) {
    value = rk >> 2;
  } else {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setUint32(4, rk & 0xfffffffc, true);
    value = dv.getFloat64(0, true);
  }
  return rk & 0x01 ? value / 100 : value;
}

type Reader = { bytes: Uint8Array; view: DataView; at: number };

/**
 * Read one shared string, following CONTINUE boundaries.
 *
 * A string may be split across records, and each continuation restarts with its
 * own compression flag — the same string can be 8-bit on one side of the break
 * and UTF-16 on the other. `boundaries` holds the offsets where that happens.
 */
function readSharedString(r: Reader, boundaries: number[]): string {
  const chars = r.view.getUint16(r.at, true);
  r.at += 2;
  let flags = r.bytes[r.at++];

  let richRuns = 0;
  let extSize = 0;
  if (flags & 0x08) {
    richRuns = r.view.getUint16(r.at, true);
    r.at += 2;
  }
  if (flags & 0x04) {
    extSize = r.view.getUint32(r.at, true);
    r.at += 4;
  }

  let out = "";
  let read = 0;
  while (read < chars) {
    if (boundaries.includes(r.at)) flags = r.bytes[r.at++];
    if (flags & 0x01) {
      out += String.fromCharCode(r.view.getUint16(r.at, true));
      r.at += 2;
    } else {
      out += String.fromCharCode(r.bytes[r.at]);
      r.at += 1;
    }
    read += 1;
  }

  r.at += richRuns * 4 + extSize;
  return out;
}

function readSst(bytes: Uint8Array, boundaries: number[]): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const unique = view.getUint32(4, true);
  const r: Reader = { bytes, view, at: 8 };

  const strings: string[] = [];
  for (let i = 0; i < unique && r.at < bytes.length; i++) {
    strings.push(readSharedString(r, boundaries));
  }
  return strings;
}

/**
 * Read the first worksheet of a BIFF8 workbook.
 *
 * These workbooks hold a single sheet, so cell records are taken wherever they
 * appear rather than tracked per substream.
 */
export function readXls(buffer: Uint8Array): Sheet {
  const stream = findWorkbookStream(buffer);
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);

  const cells = new Map<string, Cell>();
  let maxRow = -1;
  let maxCol = -1;
  let sst: string[] = [];

  const put = (row: number, col: number, value: Cell) => {
    cells.set(`${row}:${col}`, value);
    if (row > maxRow) maxRow = row;
    if (col > maxCol) maxCol = col;
  };

  let at = 0;
  while (at + 4 <= stream.length) {
    const type = view.getUint16(at, true);
    const size = view.getUint16(at + 2, true);
    const body = at + 4;
    if (body + size > stream.length) break;

    switch (type) {
      case REC_SST: {
        // Gather the SST together with its CONTINUE records, remembering where
        // each join lands so split strings can be decoded.
        const parts: Uint8Array[] = [stream.subarray(body, body + size)];
        const boundaries: number[] = [];
        let scan = body + size;
        let length = size;
        while (scan + 4 <= stream.length && view.getUint16(scan, true) === REC_CONTINUE) {
          const contSize = view.getUint16(scan + 2, true);
          boundaries.push(length);
          parts.push(stream.subarray(scan + 4, scan + 4 + contSize));
          length += contSize;
          scan += 4 + contSize;
        }
        const merged = new Uint8Array(length);
        let offset = 0;
        for (const p of parts) {
          merged.set(p, offset);
          offset += p.length;
        }
        sst = readSst(merged, boundaries);
        at = scan;
        continue;
      }
      case REC_LABELSST: {
        const index = view.getUint32(body + 6, true);
        put(view.getUint16(body, true), view.getUint16(body + 2, true), sst[index] ?? "");
        break;
      }
      case REC_NUMBER:
        put(
          view.getUint16(body, true),
          view.getUint16(body + 2, true),
          view.getFloat64(body + 6, true),
        );
        break;
      case REC_RK:
        put(
          view.getUint16(body, true),
          view.getUint16(body + 2, true),
          decodeRk(view.getUint32(body + 6, true)),
        );
        break;
      case REC_MULRK: {
        const row = view.getUint16(body, true);
        const firstCol = view.getUint16(body + 2, true);
        const count = (size - 6) / 6;
        for (let i = 0; i < count; i++) {
          put(row, firstCol + i, decodeRk(view.getUint32(body + 4 + i * 6 + 2, true)));
        }
        break;
      }
      case REC_BOF:
      case REC_EOF:
      default:
        break;
    }
    at = body + size;
  }

  const sheet: Sheet = [];
  for (let row = 0; row <= maxRow; row++) {
    const line: Cell[] = [];
    for (let col = 0; col <= maxCol; col++) line.push(cells.get(`${row}:${col}`) ?? null);
    sheet.push(line);
  }
  return sheet;
}
