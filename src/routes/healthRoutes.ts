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

healthRouter.get('/', (req: Request, res: Response) => {
  if (req.accepts('html') && !req.accepts('json')) {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gestione Casa — Activation Service</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen p-6 font-sans">
  <div class="max-w-4xl mx-auto space-y-6">
    <header class="border-b border-slate-800 pb-6 flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
          <span class="w-3 h-3 rounded-full bg-emerald-500 inline-block animate-pulse"></span>
          Gestione Casa Activation Service
        </h1>
        <p class="text-slate-400 text-sm mt-1">Licensing and Device Activation Backend</p>
      </div>
      <div class="text-right">
        <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-950 text-emerald-300 border border-emerald-800">
          Service Online (v0.1.0)
        </span>
      </div>
    </header>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div class="text-xs text-slate-400 font-semibold uppercase tracking-wider">Status</div>
        <div class="text-xl font-bold text-emerald-400 mt-1">Operational</div>
        <div class="text-xs text-slate-500 mt-1">Port 3000 &bull; Express 4.x</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div class="text-xs text-slate-400 font-semibold uppercase tracking-wider">Engine</div>
        <div class="text-xl font-bold text-slate-200 mt-1">v2.1 Ed25519</div>
        <div class="text-xs text-slate-500 mt-1">Canonical signing &amp; receipts</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div class="text-xs text-slate-400 font-semibold uppercase tracking-wider">Storage</div>
        <div class="text-xl font-bold text-slate-200 mt-1">PostgreSQL / In-Memory</div>
        <div class="text-xs text-slate-500 mt-1">Dual-mode persistence fallback</div>
      </div>
    </div>

    <div class="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
      <h2 class="text-lg font-semibold text-white">API Endpoints</h2>
      <div class="space-y-3 font-mono text-sm">
        <div class="flex items-center justify-between bg-slate-950 p-3 rounded-lg border border-slate-800/80">
          <div class="flex items-center gap-3">
            <span class="px-2 py-0.5 rounded text-xs font-bold bg-blue-900 text-blue-300">GET</span>
            <span class="text-slate-300">/health</span>
          </div>
          <span class="text-slate-500 text-xs font-sans">Service health check</span>
        </div>
        <div class="flex items-center justify-between bg-slate-950 p-3 rounded-lg border border-slate-800/80">
          <div class="flex items-center gap-3">
            <span class="px-2 py-0.5 rounded text-xs font-bold bg-emerald-900 text-emerald-300">POST</span>
            <span class="text-slate-300">/api/licenses/activate</span>
          </div>
          <span class="text-slate-500 text-xs font-sans">Activate device for license</span>
        </div>
        <div class="flex items-center justify-between bg-slate-950 p-3 rounded-lg border border-slate-800/80">
          <div class="flex items-center gap-3">
            <span class="px-2 py-0.5 rounded text-xs font-bold bg-emerald-900 text-emerald-300">POST</span>
            <span class="text-slate-300">/api/licenses/validate</span>
          </div>
          <span class="text-slate-500 text-xs font-sans">Validate activation token &amp; get receipt</span>
        </div>
        <div class="flex items-center justify-between bg-slate-950 p-3 rounded-lg border border-slate-800/80">
          <div class="flex items-center gap-3">
            <span class="px-2 py-0.5 rounded text-xs font-bold bg-amber-900 text-amber-300">POST</span>
            <span class="text-slate-300">/api/licenses/deactivate</span>
          </div>
          <span class="text-slate-500 text-xs font-sans">Deactivate device</span>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`);
    return;
  }

  res.status(200).json({
    status: 'ok',
    service: 'gestione-casa-activation-service',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
    endpoints: {
      health: 'GET /health',
      activate: 'POST /api/licenses/activate',
      validate: 'POST /api/licenses/validate',
      deactivate: 'POST /api/licenses/deactivate',
    },
  });
});
