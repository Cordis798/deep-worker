import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const PROJECT_ROOT = process.cwd();
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const STORE_DIR = path.join(DATA_DIR, 'db');
export const DB_PATH = path.join(STORE_DIR, 'deep-worker.db');

export const DEFAULT_WEB_PORT = 3000;
export const DEFAULT_HOST = '0.0.0.0';
export const DEFAULT_LOG_LEVEL = 'info';
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';
export const SESSION_COOKIE_NAME_SECURE = '__Host-dw_session';
export const SESSION_COOKIE_NAME_PLAIN = 'dw_session';
const SESSION_SECRET_FILE = path.join(DATA_DIR, 'config', 'session-secret.key');

export function webPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WEB_PORT ?? '';
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WEB_PORT;
}

export function hostName(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOST || DEFAULT_HOST;
}

export function logLevel(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOG_LEVEL || DEFAULT_LOG_LEVEL;
}

export function timezone(env: NodeJS.ProcessEnv = process.env): string {
  return env.TZ || DEFAULT_TIMEZONE;
}

/**
 * Layered config resolution: web-persisted settings win over environment
 * variables, which win over built-in defaults. Persistent settings are wired
 * to the config_kv database in a later stage; callers pass null until then.
 */
export function resolveConfig<T>(
  persistent: unknown,
  env: unknown,
  fallback: T,
): T {
  const value = persistent ?? env ?? fallback;
  return value as T;
}

const SENSITIVE_KEY_PATTERN =
  /(?:^|[^a-z0-9])(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|private[_-]?key)(?:[^a-z0-9]|$)/i;

export function isSensitiveConfigKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Mask secret-bearing configuration values so a config dump can be logged
 * without leaking credentials.
 */
export function redactConfig(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...input };
  for (const key of Object.keys(output)) {
    if (isSensitiveConfigKey(key)) {
      output[key] = '[REDACTED]';
    }
  }
  return output;
}

let cachedSessionSecret: string | null = null;

/**
 * Session-signing secret, persisted to a 0600 file so sessions survive
 * restarts. An explicit WEB_SESSION_SECRET env var takes precedence.
 */
export function getSessionSecret(): string {
  if (cachedSessionSecret) return cachedSessionSecret;
  if (process.env.WEB_SESSION_SECRET) {
    cachedSessionSecret = process.env.WEB_SESSION_SECRET;
    return cachedSessionSecret;
  }
  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) {
      const stored = fs.readFileSync(SESSION_SECRET_FILE, 'utf-8').trim();
      if (stored) {
        cachedSessionSecret = stored;
        return stored;
      }
    }
  } catch {
    // fall through and generate
  }
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SESSION_SECRET_FILE), { recursive: true });
    fs.writeFileSync(SESSION_SECRET_FILE, `${generated}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch {
    // non-fatal: secret works for this process only
  }
  cachedSessionSecret = generated;
  return generated;
}

export function trustProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TRUST_PROXY === 'true';
}

export function maxLoginAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.MAX_LOGIN_ATTEMPTS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

export function loginLockoutMinutes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number.parseInt(env.LOGIN_LOCKOUT_MINUTES ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 15;
}

export function allowRegistration(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ALLOW_REGISTRATION !== 'false';
}

export function requireInviteCode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REQUIRE_INVITE_CODE === 'true';
}
