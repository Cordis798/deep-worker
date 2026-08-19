import type Database from 'better-sqlite3';
import { createApp, type App } from '../app.js';
import { initDatabase } from '../db/migration.js';

process.env.WEB_SESSION_SECRET = 'test-session-secret';

export function makeApp(): { db: Database.Database; app: App } {
  const db = initDatabase(':memory:');
  return { db, app: createApp({ db }) };
}

export function cookieValue(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (!header) return '';
  const match = header.match(/dw_session=([^;]+)/);
  return match ? match[1] : '';
}

export function jsonRequest(
  path: string,
  body: unknown,
  cookie?: string,
  method: 'POST' | 'PATCH' = 'POST',
): { method: 'POST' | 'PATCH'; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = `dw_session=${cookie}`;
  return { method, headers, body: JSON.stringify(body) };
}

export function cookieRequest(
  cookie?: string,
  method?: 'GET' | 'POST' | 'DELETE',
): { method?: string; headers: Record<string, string> } {
  return {
    ...(method ? { method } : {}),
    headers: cookie ? { cookie: `dw_session=${cookie}` } : {},
  };
}
