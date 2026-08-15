import { Router } from 'express';
import type { Request, Response } from 'express';

export const healthRouter = Router();

healthRouter.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'gestione-casa-activation-service',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
  });
});