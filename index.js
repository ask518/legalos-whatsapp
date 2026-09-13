/**
 * LegalOS Standalone Baileys WhatsApp Gateway Server
 */
import express from 'express';
import cors from 'cors';
import { whatsappRouter, startWhatsApp } from './whatsapp-gateway.js';

const app = express();

const configuredOrigins = (process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (configuredOrigins.includes(origin)) return callback(null, true);
    if (/^https:\/\/.*\.vercel\.app$/.test(origin)) return callback(null, true);
    if (/^https:\/\/.*\.back4app\.io$/.test(origin)) return callback(null, true);
    if (/^https:\/\/.*\.b4a\.run$/.test(origin)) return callback(null, true);
    if (/^http:\/\/localhost:\d+$/.test(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-tenant-id', 'x-session-id', 'x-user-role', 'x-admin-role', 'x-target-tenant-id']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'LegalOS Baileys WhatsApp Gateway',
    environment: process.env.NODE_ENV || 'production',
    version: '2.5.0'
  });
});

app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'LegalOS Baileys WhatsApp Gateway' });
});

app.use('/api/whatsapp', whatsappRouter);
app.use('/whatsapp', whatsappRouter);

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(`⚖️  LegalOS Baileys WhatsApp Standalone Gateway Online`);
  console.log(`📲  WhatsApp Gateway: http://0.0.0.0:${PORT}/api/whatsapp`);
  console.log(`🏥  Health Check: http://0.0.0.0:${PORT}/health`);
  console.log(`=======================================================`);

  startWhatsApp().catch(err => console.warn('Baileys initial connect note:', err.message));
});

export default app;
