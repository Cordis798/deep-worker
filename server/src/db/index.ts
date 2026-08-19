import { DB_PATH } from '../config.js';
import { initDatabase, type InitDatabaseOptions } from './migration.js';

/**
 * Open the configured application database, running migrations as needed.
 */
export function openDatabase(
  options: InitDatabaseOptions = {},
): ReturnType<typeof initDatabase> {
  return initDatabase(DB_PATH, options);
}
