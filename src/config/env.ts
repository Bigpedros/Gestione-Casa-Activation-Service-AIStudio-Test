export interface AppConfig {
  nodeEnv: string;
  port: number;
  corsAllowedOrigins: string[];
  licensePrivateKey?: string;
  licenseActiveKeyId: string;
  licensePublicKey?: string;
  databaseUrl?: string;
}

export function loadConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const port = parseInt(process.env.PORT || '3000', 10);
  const corsAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '*')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const licensePrivateKey = process.env.LICENSE_PRIVATE_KEY;
  const licenseActiveKeyId = process.env.LICENSE_ACTIVE_KEY_ID || 'key-2026-v1';
  const licensePublicKey = process.env.LICENSE_PUBLIC_KEY;
  const databaseUrl = process.env.DATABASE_URL;

  if (nodeEnv === 'production') {
    if (!licensePrivateKey) {
      throw new Error('FATAL: LICENSE_PRIVATE_KEY environment variable is required in production');
    }
    if (!licenseActiveKeyId) {
      throw new Error('FATAL: LICENSE_ACTIVE_KEY_ID environment variable is required in production');
    }
    if (!databaseUrl) {
      throw new Error('FATAL: DATABASE_URL environment variable is required in production');
    }
  }

  return {
    nodeEnv,
    port,
    corsAllowedOrigins,
    licensePrivateKey,
    licenseActiveKeyId,
    licensePublicKey,
    databaseUrl,
  };
}
