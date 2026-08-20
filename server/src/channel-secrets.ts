import crypto from 'node:crypto';
import { getSessionSecret } from './config.js';

const VERSION = 'v1';

function encryptionKey(): Buffer {
  return crypto.createHash('sha256').update(process.env.DEEP_WORKER_CHANNEL_SECRET ?? getSessionSecret()).digest();
}

export function encryptChannelCredentials(credentials: Record<string, unknown>): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptChannelCredentials(value: string): Record<string, unknown> {
  const [version, ivValue, tagValue, encryptedValue] = value.split('.');
  if (version !== VERSION || !ivValue || !tagValue || !encryptedValue) throw new Error('渠道凭据密文格式无效');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
  const parsed: unknown = JSON.parse(plaintext);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('渠道凭据内容无效');
  return parsed as Record<string, unknown>;
}
