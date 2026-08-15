import type { Request, Response, NextFunction } from 'express';

export function errorHandlerMiddleware(
  err: Error & { status?: number },
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  const statusCode = err.status || 500;
  const isProduction = process.env.NODE_ENV === 'production';

  res.status(statusCode).json({
    error: {
      code: statusCode === 400 ? 'INVALID_REQUEST' : 'INTERNAL_SERVER_ERROR',
      message: err.message || 'An unexpected error occurred',
      ...(isProduction ? {} : { stack: err.stack }),
    },
  });
}
