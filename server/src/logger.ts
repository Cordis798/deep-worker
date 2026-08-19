import pino from 'pino';
import type { Logger } from 'pino';
import { logLevel } from './config.js';

export const REDACTED = '[REDACTED]';

const MAX_ERROR_MESSAGE_LENGTH = 2000;
const MAX_STRUCTURE_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Redact credentials that may be embedded in an otherwise useful diagnostic
 * string (provider errors, stack frames, URL userinfo, common token formats).
 */
export function redactLogMessage(value: string): string {
  const bounded =
    value.length > MAX_ERROR_MESSAGE_LENGTH
      ? `${value.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…[truncated]`
      : value;
  return bounded
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-=]+/giu, `$1 ${REDACTED}`)
    .replace(
      /(\b(?:authorization|cookie|token|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\b["']?\s*[=:]\s*)(?:"[^"\n]*"?|'[^'\n]*'?|[^\s"',;]+)/giu,
      `$1${REDACTED}`,
    )
    .replace(
      /(\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/:@]+:)[^\s@/?#]+(@)/giu,
      `$1${REDACTED}$2`,
    )
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/gu, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/gu, REDACTED)
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/gu,
      REDACTED,
    );
}

/**
 * Convert an arbitrary thrown value into a diagnostic-only shape. Only the
 * name/message/stack (redacted and bounded) and numeric status/code survive;
 * SDK request objects that embed credentials never cross the logging boundary.
 */
export function serializeErrorForLog(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    return { message: redactLogMessage(value) };
  }
  const record = asRecord(value);
  if (!record) {
    return { message: redactLogMessage(String(value)) };
  }
  const message = readString(record, 'message');
  const name = readString(record, 'name');
  const stack = readString(record, 'stack');
  const code = (record as { code?: unknown }).code;

  const output: Record<string, unknown> = {
    message: redactLogMessage(message || 'Unknown error'),
  };
  if (name) output.name = redactLogMessage(name);
  if (typeof code === 'string') {
    output.code = redactLogMessage(code);
  } else if (typeof code === 'number' && Number.isFinite(code)) {
    output.code = code;
  }
  if (stack) output.stack = redactLogMessage(stack);
  return output;
}

function isSensitiveLogKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    normalized === 'authorization' ||
    normalized === 'cookie' ||
    normalized === 'setcookie' ||
    normalized === 'password' ||
    normalized === 'passwd' ||
    normalized === 'sessionid' ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('apikey') ||
    normalized.includes('authkey')
  );
}

function sanitizeLogValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === 'string') return redactLogMessage(value);
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined') return undefined;
  if (typeof value === 'symbol' || typeof value === 'function') {
    return String(value);
  }
  if (value instanceof Error) return serializeErrorForLog(value);
  if (depth >= MAX_STRUCTURE_DEPTH) return '[MaxDepth]';

  const object = value as object;
  if (seen.has(object)) return '[Circular]';
  seen.add(object);

  if (Array.isArray(value)) {
    const sanitized = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeLogValue(item, seen, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) sanitized.push('[Truncated]');
    return sanitized;
  }

  const record = asRecord(value);
  if (!record) return String(value);
  const sanitized: Record<string, unknown> = {};
  let count = 0;
  for (const key of Object.keys(record)) {
    if (count >= MAX_OBJECT_KEYS) {
      sanitized.__truncated__ = true;
      break;
    }
    count += 1;
    sanitized[key] = isSensitiveLogKey(key)
      ? REDACTED
      : sanitizeLogValue(record[key], seen, depth + 1);
  }
  return sanitized;
}

/**
 * Sanitize every structured log field, including errors nested under arbitrary
 * keys. This is the boundary that keeps unfamiliar SDK error shapes from
 * serializing raw credentials.
 */
export function sanitizeLogObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeLogValue(value, new WeakSet<object>(), 0) as Record<
    string,
    unknown
  >;
}

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? logLevel();
  const pretty =
    options.pretty ?? (process.env.NODE_ENV !== 'test' ? true : false);
  const pinoOptions: pino.LoggerOptions = {
    level,
    serializers: { err: serializeErrorForLog, error: serializeErrorForLog },
    formatters: {
      log: (object) => sanitizeLogObject(object as Record<string, unknown>),
    },
    redact: {
      paths: [
        'password',
        'secret',
        'token',
        'authorization',
        'cookie',
        '*.password',
        '*.secret',
        '*.token',
        '*.authorization',
        '*.cookie',
        '*.apiKey',
        '*.api_key',
        '*.appSecret',
        '*.app_secret',
        '*.botToken',
        '*.bot_token',
        '*.headers.authorization',
        '*.headers.cookie',
        '*.config.headers.authorization',
        '*.config.headers.cookie',
        '*.request._header',
        '*.response.request._header',
      ],
      censor: REDACTED,
    },
  };
  if (pretty) {
    pinoOptions.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:mm:ss.l',
      },
    };
  }
  return pino(pinoOptions);
}

export const logger = createLogger();

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
