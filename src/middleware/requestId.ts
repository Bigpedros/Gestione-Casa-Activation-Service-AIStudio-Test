import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';

export interface RequestWithId extends Request {
  id?: string;
}

export function requestIdMiddleware(req: RequestWithId, res: Response, next: NextFunction): void {
  const incomingId = req.header('x-request-id');
  const requestId = incomingId || crypto.randomUUID();
  req.id = requestId;
  res.setHeader('x-request-id', requestId);
  next();
}
