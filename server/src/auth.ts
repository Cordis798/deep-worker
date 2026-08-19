import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  getSessionSecret,
  loginLockoutMinutes,
  SESSION_COOKIE_NAME_PLAIN,
  SESSION_COOKIE_NAME_SECURE,
  trustProxy,
} from './config.js';

const BCRYPT_ROUNDS = 12;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function signSessionToken(token: string): string {
  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(token)
    .digest('hex');
  return `${token}.${sig}`;
}

export function verifySessionToken(
  signedValue: string,
): { token: string; legacy: boolean } | null {
  const dotIndex = signedValue.lastIndexOf('.');
  if (dotIndex === -1) {
    if (!/^[0-9a-f]{64}$/.test(signedValue)) return null;
    return { token: signedValue, legacy: true };
  }
  const token = signedValue.substring(0, dotIndex);
  const sig = signedValue.substring(dotIndex + 1);
  if (sig.length !== 64) return null;
  const expected = crypto
    .createHmac('sha256', getSessionSecret())
    .update(token)
    .digest('hex');
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (
    sigBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return null;
  }
  return { token, legacy: false };
}

interface CookieContext {
  req: { url: string; header(key: string): string | undefined };
}

function isSecureRequest(c: CookieContext): boolean {
  if (trustProxy() && c.req.header('x-forwarded-proto') === 'https') {
    return true;
  }
  return c.req.url.startsWith('https://');
}

function cookieName(c: CookieContext): { name: string; secure: boolean } {
  const secure = isSecureRequest(c);
  return {
    name: secure ? SESSION_COOKIE_NAME_SECURE : SESSION_COOKIE_NAME_PLAIN,
    secure,
  };
}

export function setSessionCookie(c: CookieContext, token: string): string {
  const { name, secure } = cookieName(c);
  const secureSuffix = secure ? '; Secure' : '';
  return `${name}=${signSessionToken(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secureSuffix}`;
}

export function clearSessionCookie(c: CookieContext): string {
  const { name, secure } = cookieName(c);
  const secureSuffix = secure ? '; Secure' : '';
  return `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureSuffix}`;
}

export function cookieNamePlain(): string {
  return SESSION_COOKIE_NAME_PLAIN;
}

export function generateUserId(): string {
  return crypto.randomUUID();
}

export function generateInviteCode(): string {
  return crypto.randomBytes(16).toString('hex');
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

export function validateUsername(username: string): string | null {
  if (!username || typeof username !== 'string') return '用户名不能为空';
  if (!USERNAME_RE.test(username)) return '用户名须为3-32位字母、数字或下划线';
  return null;
}

export function validatePassword(password: string): string | null {
  if (!password || typeof password !== 'string') return '密码不能为空';
  if (password.length < PASSWORD_MIN) return `密码长度不能少于${PASSWORD_MIN}位`;
  if (password.length > PASSWORD_MAX) return `密码长度不能超过${PASSWORD_MAX}位`;
  return null;
}

interface AttemptRecord {
  count: number;
  firstAttempt: number;
  lastAttempt: number;
}

const loginAttempts = new Map<string, AttemptRecord>();
const GLOBAL_USERNAME_MULTIPLIER = 4;
const GLOBAL_USERNAME_WINDOW_MS = 60 * 60 * 1000;

function checkRecord(
  key: string,
  maxAttempts: number,
  windowMs: number,
): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const record = loginAttempts.get(key);
  if (!record) return { allowed: true };
  if (now - record.firstAttempt > windowMs) {
    loginAttempts.delete(key);
    return { allowed: true };
  }
  if (record.count >= maxAttempts) {
    const retryAfter = Math.ceil((record.firstAttempt + windowMs - now) / 1000);
    return { allowed: false, retryAfterSeconds: Math.max(1, retryAfter) };
  }
  return { allowed: true };
}

export function checkLoginRateLimit(
  username: string,
  ip: string,
  maxAttempts: number,
  lockoutMinutes: number,
): { allowed: boolean; retryAfterSeconds?: number } {
  const windowMs = lockoutMinutes * 60 * 1000;
  const ipCheck = checkRecord(`${username}:${ip}`, maxAttempts, windowMs);
  if (!ipCheck.allowed) return ipCheck;
  const globalMax = maxAttempts * GLOBAL_USERNAME_MULTIPLIER;
  return checkRecord(
    `user:${username}`,
    globalMax,
    GLOBAL_USERNAME_WINDOW_MS,
  );
}

function increment(key: string, now: number): void {
  const record = loginAttempts.get(key);
  if (record) {
    record.count += 1;
    record.lastAttempt = now;
  } else {
    loginAttempts.set(key, { count: 1, firstAttempt: now, lastAttempt: now });
  }
}

export function recordLoginAttempt(username: string, ip: string): void {
  const now = Date.now();
  increment(`${username}:${ip}`, now);
  increment(`user:${username}`, now);
}

export function clearLoginAttempts(username: string, ip: string): void {
  loginAttempts.delete(`${username}:${ip}`);
}

export function loginLockoutMs(): number {
  return loginLockoutMinutes() * 60 * 1000;
}

export function sessionExpiresAt(): string {
  return new Date(Date.now() + SESSION_TTL_MS).toISOString();
}

export function isSessionExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() < Date.now();
}
