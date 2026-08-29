/**
 * LegalOS Enterprise Unified Backend Server
 * Bundles Multi-Tenant REST APIs, Real-time SSE Stream, Object Storage, and Baileys WhatsApp Gateway.
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tenantContextMiddleware } from './middleware/tenantIsolation.js';
import { apiRouter, broadcastTenantEvent } from './api/routes.js';
import { whatsappRouter, startWhatsApp } from './whatsapp-gateway.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Mount WhatsApp Gateway router directly
app.use('/api/whatsapp', whatsappRouter);

// Mount Multi-Tenant Middleware on other API routes
app.use('/api', tenantContextMiddleware);
app.use('/api', apiRouter);

// Health Check Endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ONLINE',
    system: 'LegalOS Enterprise Platform Engine',
    version: '2026.3.0-PROD',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`⚖️  LegalOS Enterprise Multi-Tenant Server Online`);
  console.log(`🌐  API Gateway: http://localhost:${PORT}/api`);
  console.log(`📲  WhatsApp Gateway: http://localhost:${PORT}/api/whatsapp`);
  console.log(`📡  SSE Real-time Bus: http://localhost:${PORT}/api/events/stream`);
  console.log(`🏥  Health Check: http://localhost:${PORT}/health`);
  console.log(`=======================================================`);

  // Initialize WhatsApp Baileys engine in background
  startWhatsApp().catch(err => console.warn('Baileys initial connect note:', err.message));
});

export default app;
