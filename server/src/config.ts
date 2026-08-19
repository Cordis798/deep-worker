import path from 'node:path';

export const PROJECT_ROOT = process.cwd();
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const STORE_DIR = path.join(DATA_DIR, 'db');
export const DB_PATH = path.join(STORE_DIR, 'deep-worker.db');

export const DEFAULT_WEB_PORT = 3000;
export const DEFAULT_HOST = '0.0.0.0';
export const DEFAULT_LOG_LEVEL = 'info';
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

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
