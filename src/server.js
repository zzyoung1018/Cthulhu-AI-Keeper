import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const { server, database } = createApp({ config });

server.listen(config.port, config.host, () => {
  console.log(`DM Online listening on http://${config.host}:${config.port}`);
});

let isShuttingDown = false;
let isDatabaseClosed = false;

function closeDatabase() {
  if (isDatabaseClosed) return;
  isDatabaseClosed = true;
  database.close();
}

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}, shutting down`);
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });

  server.closeIdleConnections?.();
  setTimeout(() => {
    server.closeAllConnections?.();
    closeDatabase();
    process.exit(0);
  }, 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
