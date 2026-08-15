import express from 'express';
import type { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { loadConfig } from './config/env.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { errorHandlerMiddleware } from './middleware/errorHandler.js';
import { healthRouter } from './routes/healthRoutes.js';
import { licenseRouter } from './routes/licenseRoutes.js';

export function createApp(): Express {
  const config = loadConfig();
  const app = express();

  // Security Headers
  app.use(helmet());

  // Request ID
  app.use(requestIdMiddleware);

  // CORS
  app.use(
    cors({
      origin: config.corsAllowedOrigins.includes('*') ? '*' : config.corsAllowedOrigins,
    })
  );

  // Rate Limiting
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      status: 'error',
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many requests, please try again later.',
    },
  });
  app.use('/api/', limiter);

  // Body parser with 64kb limit
  app.use(express.json({ limit: '64kb' }));

  // Routes
  app.use('/', healthRouter);
  app.use('/api/licenses', licenseRouter);

  // Error handling
  app.use(errorHandlerMiddleware);

  return app;
}
