/** Read only Exif DateTimeOriginal and OffsetTimeOriginal; never expose other metadata. */
export function exifCapturedAt(exif?: Buffer, now = new Date()): Date | null {
  if (!exif || exif.length > 1024 * 1024 || !Number.isFinite(now.getTime()))
    return null;
  try {
    const base = exif.subarray(0, 6).equals(Buffer.from('Exif\0\0')) ? 6 : 0;
    const data = exif.subarray(base);
    const order = data.toString('ascii', 0, 2);
    if (order !== 'II' && order !== 'MM') return null;
    const u16 = (at: number) =>
      order === 'II' ? data.readUInt16LE(at) : data.readUInt16BE(at);
    const u32 = (at: number) =>
      order === 'II' ? data.readUInt32LE(at) : data.readUInt32BE(at);
    if (u16(2) !== 42) return null;
    const entries = (offset: number) => {
      if (offset < 8 || offset + 2 > data.length)
        throw new Error('Invalid IFD');
      const count = u16(offset);
      if (count > 1024 || offset + 2 + count * 12 + 4 > data.length)
        throw new Error('Invalid IFD bounds');
      return Array.from({ length: count }, (_, i) => offset + 2 + i * 12);
    };
    const pointers = entries(u32(4)).filter((at) => u16(at) === 0x8769);
    if (
      pointers.length !== 1 ||
      u16(pointers[0] + 2) !== 4 ||
      u32(pointers[0] + 4) !== 1
    )
      return null;
    const tags = entries(u32(pointers[0] + 8));
    const ascii = (tag: number, length: number): string | undefined => {
      const found = tags.filter((at) => u16(at) === tag);
      if (!found.length) return undefined;
      if (found.length !== 1) throw new Error('Duplicate EXIF date');
      const at = found[0];
      if (u16(at + 2) !== 2 || u32(at + 4) !== length)
        throw new Error('Invalid EXIF date type');
      const start = length <= 4 ? at + 8 : u32(at + 8);
      if (
        start < 8 ||
        start + length > data.length ||
        data[start + length - 1] !== 0
      )
        throw new Error('Invalid EXIF date bounds');
      const value = data.subarray(start, start + length - 1);
      if (value.some((byte) => byte > 127)) throw new Error('Invalid ASCII');
      return value.toString('ascii');
    };
    const date = ascii(0x9003, 20);
    if (!date || !/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(date))
      return null;
    const [year, month, day, hour, minute, second] = date
      .split(/[: ]/)
      .map(Number);
    if (
      year < 1800 ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      hour > 23 ||
      minute > 59 ||
      second > 59
    )
      return null;
    const local = new Date(
      Date.UTC(year, month - 1, day, hour, minute, second)
    );
    if (
      local.getUTCFullYear() !== year ||
      local.getUTCMonth() !== month - 1 ||
      local.getUTCDate() !== day
    )
      return null;
    const offset = ascii(0x9011, 7);
    let offsetMinutes = 540;
    if (offset !== undefined) {
      if (!/^[+-]\d{2}:\d{2}$/.test(offset)) return null;
      const hours = Number(offset.slice(1, 3));
      const minutes = Number(offset.slice(4, 6));
      if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0))
        return null;
      offsetMinutes = (hours * 60 + minutes) * (offset[0] === '-' ? -1 : 1);
    }
    const instant = new Date(local.getTime() - offsetMinutes * 60_000);
    const kstDay = (value: Date) =>
      new Date(value.getTime() + 540 * 60_000).toISOString().slice(0, 10);
    if (kstDay(instant) < '1800-01-01' || kstDay(instant) > kstDay(now))
      return null;
    return instant;
  } catch {
    // Corrupt optional metadata must not reject an otherwise valid photograph.
    return null;
  }
}
