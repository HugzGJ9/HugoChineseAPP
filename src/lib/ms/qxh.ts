// OneDrive's quickXorHash: the content identity of a workbook version (D2). Same value as `file.hashes.quickXorHash`.
// Port of rclone's backend/onedrive/quickxorhash (MIT), itself from namazso/QuickXorHash (0BSD).
// Byte i of the input is XORed into a 160-bit ring at bit (11 * i) mod 160; the length (little endian) is XORed into the
// last 8 bytes. Implemented as rclone does: fold the input into a 1760-byte buffer (160 * 11 bytes, after which the bit
// positions repeat), then spread the buffer over the ring once.

const SIZE = 20;
const SHIFT = 11;
const DATA = SHIFT * 8 * SIZE; // 1760

/** quickXorHash of `bytes`, base64 (28 characters), as OneDrive reports it. */
export function quickXorHash(bytes: Uint8Array): string {
  const data = new Uint8Array(DATA);
  const n = bytes.length;
  for (let start = 0; start < n; start += DATA) {
    const end = Math.min(n, start + DATA);
    for (let i = start, j = 0; i < end; i++, j++) data[j] ^= bytes[i];
  }
  const h = new Uint8Array(SIZE + 1);
  for (let i = 0; i < DATA; i++) {
    const shift = (i * SHIFT) % 160;
    const shifted = data[i] << (shift % 8);
    const at = shift >> 3;
    h[at] ^= shifted & 0xff;
    h[at + 1] ^= shifted >> 8;
  }
  h[0] ^= h[SIZE];
  // The length, little endian, into the last 8 bytes. Lengths stay far below 2^53, so plain arithmetic is exact.
  let len = n;
  for (let k = 0; k < 8; k++) {
    h[SIZE - 8 + k] ^= len % 256;
    len = Math.floor(len / 256);
  }
  let s = '';
  for (let i = 0; i < SIZE; i++) s += String.fromCharCode(h[i]);
  return btoa(s);
}
