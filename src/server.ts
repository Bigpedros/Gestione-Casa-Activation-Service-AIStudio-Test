import { createApp } from './app.js';
import { loadConfig } from './config/env.js';

const config = loadConfig();
const app = createApp();

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[Activation-Service] Server listening on port ${config.port} (env: ${config.nodeEnv})`);
});

process.on('SIGTERM', () => {
  console.log('[Activation-Service] SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('[Activation-Service] HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Activation-Service] SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('[Activation-Service] HTTP server closed');
    process.exit(0);
  });
});
