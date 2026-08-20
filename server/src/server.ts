import { serve as serveHono, type ServerType } from '@hono/node-server';
import { createApp, type App } from './app.js';
import { hostName, webPort } from './config.js';
import { openDatabase } from './db/index.js';
import { logger } from './logger.js';

export interface ServerHandle {
  server: ServerType;
  port: number;
  close: () => Promise<void>;
}

export interface StartServerOptions {
  app: App;
  port: number;
  host?: string;
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export function startServer(options: StartServerOptions): Promise<ServerHandle> {
  const { app, port, host } = options;
  return new Promise<ServerHandle>((resolve, reject) => {
    let server: ServerType;
    try {
      server = serveHono(
        {
          fetch: (request: Request) => app.fetch(request),
          port,
          hostname: host ?? '0.0.0.0',
        },
        (info) => {
          resolve({
            server,
            port: info.port ?? port,
            close: () => closeServer(server),
          });
        },
      );
    } catch (error) {
      reject(error);
      return;
    }
    server.on('error', (error) => reject(error));
  });
}

export async function main(): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase();
  } catch (error) {
    logger.fatal({ err: error }, 'Database initialization failed');
    process.exit(1);
  }
  if (!db) process.exit(1);

  const app = createApp({ db });
  let handle: ServerHandle;
  try {
    handle = await startServer({ app, port: webPort(), host: hostName() });
    app.injectWebSocket(handle.server);
  } catch (error) {
    logger.fatal(
      { err: error, port: webPort() },
      'Failed to start server (port may be in use)',
    );
    process.exit(1);
  }

  logger.info({ port: handle.port }, 'Server listening');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    await handle.close();
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
