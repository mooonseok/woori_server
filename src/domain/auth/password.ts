import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
const options = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
let running = 0;
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  // Bound per-process memory consumption independently of shared rate limits.
  if (running >= 2)
    throw new ServiceUnavailableException({
      code: 'AUTH_BUSY',
      message: '잠시 후 다시 시도해 주세요.',
    });
  running += 1;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 64, options, (error, result) =>
        error ? reject(error) : resolve(result)
      );
    });
  } finally {
    running -= 1;
  }
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const digest = await derive(password, salt);
  return `scrypt$131072$8$1$${salt.toString('hex')}$${digest.toString('hex')}`;
}
export async function verifyPassword(
  password: string,
  encoded?: string
): Promise<boolean> {
  const match = /^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(
    encoded ?? ''
  );
  // An unknown account still pays exactly the same expensive derivation.
  const salt = match ? Buffer.from(match[1], 'hex') : Buffer.alloc(16, 0x31);
  const expected = match ? Buffer.from(match[2], 'hex') : Buffer.alloc(64);
  const derived = await derive(password, salt);
  return timingSafeEqual(derived, expected) && Boolean(match);
}
