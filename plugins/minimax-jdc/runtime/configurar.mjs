// Generated from the tested canonical bridge helper exports.
import {deflateSync} from "node:zlib";
export function topLevel(text) {
  const firstTable = text.search(/^\s*\[/m);
  return firstTable < 0 ? text : text.slice(0, firstTable);
}

export function setProvider(text, value) {
  const firstTable = text.search(/^\s*\[/m);
  const head = firstTable < 0 ? text : text.slice(0, firstTable);
  const tail = firstTable < 0 ? '' : text.slice(firstTable);
  let next = head.replace(/^[ \t]*model_provider\s*=\s*[^\r\n]*\r?\n?/m, '');
  if (value) next = 'model_provider = ' + JSON.stringify(value) + '\n' + next;
  return next + tail;
}

export function visionFixture() {
  const width = 32, height = 32;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw[y * (width * 3 + 1) + 1 + x * 3] = 255;
  const chunk = (type, data) => {
    const name = Buffer.from(type), bytes = Buffer.concat([name, data]);
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), check = Buffer.alloc(4);
    size.writeUInt32BE(data.length); check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, bytes, check]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}
