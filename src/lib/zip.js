/**
 * Minimal ZIP writer, store method only (no compression).
 *
 * Per-resource template generation produces one file per named value and
 * backend, which would otherwise mean one download prompt each. JSON compresses
 * well, but adding a deflate implementation to save a few kilobytes is not worth
 * the code; stored entries are valid ZIP and every tool reads them.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, which is what the ZIP format stores. */
function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() / 2) & 0x1f);
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { time, day };
}

class ByteWriter {
  constructor() {
    this.parts = [];
    this.length = 0;
  }
  bytes(arr) {
    this.parts.push(arr);
    this.length += arr.length;
  }
  u16(value) {
    this.bytes(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }
  u32(value) {
    this.bytes(
      new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff])
    );
  }
  concat() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

/**
 * @param {Array<{name: string, text: string}>} files
 * @returns {Blob} a ZIP archive
 */
export function makeZip(files, date = new Date()) {
  const encoder = new TextEncoder();
  const { time, day } = dosDateTime(date);
  const body = new ByteWriter();
  const central = new ByteWriter();

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = encoder.encode(file.text);
    const crc = crc32(dataBytes);
    const offset = body.length;

    // Local file header
    body.u32(0x04034b50);
    body.u16(20); // version needed
    body.u16(0x0800); // UTF-8 filenames
    body.u16(0); // stored
    body.u16(time);
    body.u16(day);
    body.u32(crc);
    body.u32(dataBytes.length);
    body.u32(dataBytes.length);
    body.u16(nameBytes.length);
    body.u16(0);
    body.bytes(nameBytes);
    body.bytes(dataBytes);

    // Central directory entry
    central.u32(0x02014b50);
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(0x0800);
    central.u16(0);
    central.u16(time);
    central.u16(day);
    central.u32(crc);
    central.u32(dataBytes.length);
    central.u32(dataBytes.length);
    central.u16(nameBytes.length);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u32(0);
    central.u32(offset);
    central.bytes(nameBytes);
  }

  const centralBytes = central.concat();
  const bodyBytes = body.concat();

  const end = new ByteWriter();
  end.u32(0x06054b50);
  end.u16(0);
  end.u16(0);
  end.u16(files.length);
  end.u16(files.length);
  end.u32(centralBytes.length);
  end.u32(bodyBytes.length);
  end.u16(0);

  return new Blob([bodyBytes, centralBytes, end.concat()], { type: 'application/zip' });
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
