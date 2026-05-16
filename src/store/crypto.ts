import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // bytes
const IV_LENGTH = 12;  // bytes — recommended for GCM
const TAG_LENGTH = 16; // bytes

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY ?? '';
  if (!raw) throw new Error('Missing required env var: ENCRYPTION_KEY');
  // Accept either a 64-char hex string or a raw 32-byte key
  const buf = raw.length === 64 ? Buffer.from(raw, 'hex') : Buffer.from(raw);
  if (buf.length !== KEY_LENGTH) {
    throw new Error(`ENCRYPTION_KEY must be 32 bytes (64 hex chars). Got ${buf.length} bytes.`);
  }
  return buf;
}

/** Encrypts plaintext and returns a single base64 string: iv + tag + ciphertext */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: [12 bytes iv][16 bytes tag][n bytes ciphertext]
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/** Decrypts a value produced by encrypt(). Throws on tampered or invalid data. */
export function decrypt(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

/** Prints a freshly generated key to stdout — run once, paste into .env */
export function generateKey(): string {
  return randomBytes(KEY_LENGTH).toString('hex');
}
