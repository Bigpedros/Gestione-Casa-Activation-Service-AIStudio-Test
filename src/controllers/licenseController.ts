import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { ActivationValidator } from '@gestione-casa/shared-sdk/activation';
import { ActivationService } from '../services/activationService.js';

const defaultActivationService = new ActivationService();

export class LicenseController {
  public static async activate(req: Request, res: Response): Promise<void> {
    const validation = ActivationValidator.validateActivationRequest(req.body);
    if (!validation.isValid) {
      res.status(400).json({
        status: 'error',
        code: 'INVALID_ACTIVATION_REQUEST',
        message: 'The activation request payload is invalid',
        issues: validation.issues,
      });
      return;
    }

    try {
      const requestId = (req as any).id || res.getHeader('x-request-id') || crypto.randomUUID();
      const response = await defaultActivationService.activate(req.body, String(requestId));
      const statusCode = response.status === 'SERVER_ERROR' ? 500 : 200;
      res.status(statusCode).json(response);
    } catch (error: any) {
      res.status(500).json({
        status: 'SERVER_ERROR',
        message: error?.message || 'An unexpected error occurred during activation',
        serverTime: new Date().toISOString(),
        requestId: (req as any).id || '',
      });
    }
  }

  public static async validate(req: Request, res: Response): Promise<void> {
    const validation = ActivationValidator.validateLicenseValidationRequest(req.body);
    if (!validation.isValid) {
      res.status(400).json({
        status: 'error',
        code: 'INVALID_VALIDATION_REQUEST',
        message: 'The license validation request payload is invalid',
        issues: validation.issues,
      });
      return;
    }

    try {
      const requestId = (req as any).id || res.getHeader('x-request-id') || crypto.randomUUID();
      const response = await defaultActivationService.validate(req.body, String(requestId));
      const statusCode = response.status === 'SERVER_ERROR' ? 500 : 200;
      res.status(statusCode).json(response);
    } catch (error: any) {
      res.status(500).json({
        status: 'SERVER_ERROR',
        message: error?.message || 'An unexpected error occurred during validation',
        serverTime: new Date().toISOString(),
        requestId: (req as any).id || '',
      });
    }
  }

  public static async deactivate(req: Request, res: Response): Promise<void> {
    const validation = ActivationValidator.validateLicenseDeactivationRequest(req.body);
    if (!validation.isValid) {
      res.status(400).json({
        status: 'error',
        code: 'INVALID_DEACTIVATION_REQUEST',
        message: 'The license deactivation request payload is invalid',
        issues: validation.issues,
      });
      return;
    }

    try {
      const requestId = (req as any).id || res.getHeader('x-request-id') || crypto.randomUUID();
      const response = await defaultActivationService.deactivate(req.body, String(requestId));
      const statusCode = response.status === 'SERVER_ERROR' ? 500 : 200;
      res.status(statusCode).json(response);
    } catch (error: any) {
      res.status(500).json({
        status: 'SERVER_ERROR',
        message: error?.message || 'An unexpected error occurred during deactivation',
        serverTime: new Date().toISOString(),
        requestId: (req as any).id || '',
      });
    }
  }
}
