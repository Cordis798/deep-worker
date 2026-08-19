/**
 * Load .env from the process working directory before any other module reads
 * process.env. Must be the first import in the server entry point. A missing
 * .env file is normal (every setting has a default) and is silently ignored.
 */
try {
  process.loadEnvFile();
} catch {
  /* no .env file present */
}
