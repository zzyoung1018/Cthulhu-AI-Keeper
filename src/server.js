import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const { server, database } = createApp({ config });

server.listen(config.port, config.host, () => {
  console.log(`DM Online listening on http://${config.host}:${config.port}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down`);
  server.close(() => {
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
