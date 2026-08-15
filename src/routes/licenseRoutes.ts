import { Router } from 'express';
import { LicenseController } from '../controllers/licenseController.js';

export const licenseRouter = Router();

licenseRouter.post('/activate', LicenseController.activate);
licenseRouter.post('/validate', LicenseController.validate);
licenseRouter.post('/deactivate', LicenseController.deactivate);
