import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';
import pino from 'pino';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Standalone Pass-through Middlewares for Cloud Gateway Deployment
const requireSubscriptionActive = (req, res, next) => next();
const requireRole = () => (req, res, next) => next();
const checkAndIncrementQuota = async () => ({ allowed: true });
const tenantStore = { getTenant: (id) => ({ id, name: 'Mustafa Abdo Law Firm', isSubscriptionActive: true }) };

// Base directory for all tenant-partitioned credentials
const BASE_AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
if (!fs.existsSync(BASE_AUTH_DIR)) {
  try { fs.mkdirSync(BASE_AUTH_DIR, { recursive: true }); } catch {}
}

// Canonical Mustafa Abdo production tenant ID
export const MUSTAFA_ABDO_TENANT_ID = '5fcacef9-548a-4c90-af4e-cea9eaa1e682';

// Persistent per-tenant WhatsApp message ledger (survives server restarts)
const MESSAGES_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(MESSAGES_DIR)) {
  try { fs.mkdirSync(MESSAGES_DIR, { recursive: true }); } catch {}
}
const MESSAGES_DB_PATH = path.join(MESSAGES_DIR, 'whatsapp_messages.json');
const tenantMessageStore = new Map(); // tenantId -> Message[]
const MESSAGE_STORE_CAP = 500; // per-tenant retention cap

function loadTenantMessageStore() {
  try {
    if (!fs.existsSync(MESSAGES_DB_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(MESSAGES_DB_PATH, 'utf8'));
    for (const [tid, arr] of Object.entries(raw || {})) {
      if (Array.isArray(arr)) tenantMessageStore.set(String(tid), arr.slice(-MESSAGE_STORE_CAP));
    }
  } catch (err) {
    console.error('[WhatsApp] Failed to load persistent message ledger:', err.message);
  }
}

function persistTenantMessageStore() {
  try {
    const obj = {};
    for (const [tid, arr] of tenantMessageStore.entries()) obj[tid] = arr;
    fs.writeFileSync(MESSAGES_DB_PATH, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.error('[WhatsApp] Failed to persist message ledger:', err.message);
  }
}

loadTenantMessageStore();

let cloudClient = null;

function getCloudClient() {
  if (cloudClient) return cloudClient;
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  cloudClient = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return cloudClient;
}

function gatewayRefFor(msg) {
  return msg.id ? String(msg.id).slice(0, 255) : null;
}

async function syncMessageToCloud(msg) {
  const client = getCloudClient();
  if (!client || !msg) return;
  try {
    const tenantId = String(msg.tenantId || '');
    const idemKey = String(msg.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const row = {
      tenant_id: tenantId,
      recipient_phone: msg.to || msg.recipientPhone || '',
      message_body: msg.text || msg.message || '',
      delivery_status: msg.status || 'SENT',
      gateway_ref: gatewayRefFor(msg),
      idempotency_key: idemKey,
      created_at: msg.sentAt || new Date().toISOString()
    };
    const { data: existing } = await client
      .from('whatsapp_message_logs')
      .select('id, delivery_status')
      .eq('tenant_id', tenantId)
      .eq('idempotency_key', idemKey)
      .limit(1);
    if (existing && existing.length > 0) {
      await client
        .from('whatsapp_message_logs')
        .update({ delivery_status: row.delivery_status, message_body: row.message_body })
        .eq('id', existing[0].id);
    } else {
      await client.from('whatsapp_message_logs').insert(row);
    }
  } catch (err) {
    console.warn('[WhatsApp Cloud Sync] deferred (non-fatal):', err.message);
  }
}

function fireAndForgetCloudSync(msgs) {
  for (const m of msgs || []) void syncMessageToCloud(m);
}

async function fetchCloudMessages(tenantId) {
  const client = getCloudClient();
  if (!client) return null;
  try {
    const { data, error } = await client
      .from('whatsapp_message_logs')
      .select('tenant_id, recipient_phone, message_body, delivery_status, gateway_ref, created_at')
      .eq('tenant_id', String(tenantId))
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    if (!data || data.length === 0) return [];
    return data.map((r) => ({
      id: r.gateway_ref || `cloud_${r.created_at}`,
      tenantId: r.tenant_id,
      to: r.recipient_phone,
      recipientPhone: r.recipient_phone,
      text: r.message_body,
      message: r.message_body,
      sentAt: r.created_at,
      status: r.delivery_status || 'SENT',
      direction: 'outgoing'
    }));
  } catch (err) {
    console.warn('[WhatsApp Cloud Hydrate] deferred:', err.message);
    return null;
  }
}

fireAndForgetCloudSync([...tenantMessageStore.values()].flat());

export class TenantWhatsAppSessionManager {
  static sessions = new Map();
  static reconnectAttempts = new Map();
  static maxReconnectAttempts = 5;

  static sanitizeTenantId(raw) {
    if (!raw) return MUSTAFA_ABDO_TENANT_ID;
    const clean = String(raw).trim().replace(/[^a-zA-Z0-9_-]/g, '');
    return clean || MUSTAFA_ABDO_TENANT_ID;
  }

  static getAuthDirForTenant(tenantId) {
    const safeTenant = this.sanitizeTenantId(tenantId);
    const tenantDir = path.join(BASE_AUTH_DIR, `tenant_${safeTenant}`);
    if (!fs.existsSync(tenantDir)) {
      try { fs.mkdirSync(tenantDir, { recursive: true }); } catch {}
    }
    return tenantDir;
  }

  static getSession(tenantId) {
    const safeTenant = this.sanitizeTenantId(tenantId);
    return this.sessions.get(safeTenant);
  }

  static getMessages(tenantId) {
    const safeTenant = this.sanitizeTenantId(tenantId);
    return tenantMessageStore.get(safeTenant) || [];
  }

  static recordMessage(tenantId, msg) {
    const safeTenant = this.sanitizeTenantId(tenantId);
    let list = tenantMessageStore.get(safeTenant);
    if (!list) {
      list = [];
      tenantMessageStore.set(safeTenant, list);
    }
    const idx = list.findIndex(m => m.id === msg.id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...msg };
    } else {
      list.push(msg);
      if (list.length > MESSAGE_STORE_CAP) list.shift();
    }
    persistTenantMessageStore();
    void syncMessageToCloud({ tenantId: safeTenant, ...msg });
  }

  static async startWhatsApp(tenantId = MUSTAFA_ABDO_TENANT_ID) {
    const safeTenant = this.sanitizeTenantId(tenantId);
    let existingSession = this.sessions.get(safeTenant);

    if (existingSession?.connectionState === 'connected' && existingSession?.sock?.user) {
      return existingSession;
    }

    if (existingSession?.isInitializing) {
      return existingSession;
    }

    const authDir = this.getAuthDirForTenant(safeTenant);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 2000,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false
    });

    const sessionObj = {
      tenantId: safeTenant,
      sock,
      currentQR: existingSession?.currentQR || '',
      qrGeneratedAt: existingSession?.qrGeneratedAt || null,
      connectionState: 'connecting',
      connectedUser: existingSession?.connectedUser || null,
      connectedSince: existingSession?.connectedSince || null,
      isInitializing: true,
      authDir
    };

    this.sessions.set(safeTenant, sessionObj);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        sessionObj.currentQR = qr;
        sessionObj.qrGeneratedAt = Date.now();
        sessionObj.connectionState = 'qr_ready';
        this.reconnectAttempts.set(safeTenant, 0);
      }

      if (connection === 'open') {
        sessionObj.connectionState = 'connected';
        sessionObj.currentQR = '';
        sessionObj.qrGeneratedAt = null;
        sessionObj.connectedSince = new Date().toISOString();
        sessionObj.isInitializing = false;
        this.reconnectAttempts.set(safeTenant, 0);

        const rawJid = sock.user?.id || '';
        const cleanPhone = rawJid.split(':')[0].split('@')[0];
        sessionObj.connectedUser = {
          id: rawJid,
          name: sock.user?.name || 'Mustafa Abdo Law Firm',
          phone: cleanPhone ? `+${cleanPhone}` : null
        };
      }

      if (connection === 'close') {
        sessionObj.isInitializing = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        sessionObj.connectionState = 'disconnected';

        if (shouldReconnect) {
          const attempts = (this.reconnectAttempts.get(safeTenant) || 0) + 1;
          this.reconnectAttempts.set(safeTenant, attempts);
          if (attempts <= this.maxReconnectAttempts) {
            setTimeout(() => {
              this.startWhatsApp(safeTenant).catch(() => {});
            }, 3000 * attempts);
          }
        } else {
          sessionObj.sock = null;
          sessionObj.connectedUser = null;
          try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
        }
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;
      for (const msg of m.messages) {
        if (!msg.message) continue;
        const fromMe = msg.key.fromMe || false;
        const remoteJid = msg.key.remoteJid || '';
        if (remoteJid.endsWith('@g.us')) continue; // Skip group messages

        const conversationText = msg.message?.conversation || 
                                 msg.message?.extendedTextMessage?.text || 
                                 '';

        const record = {
          id: msg.key.id || `recv_${Date.now()}`,
          tenantId: safeTenant,
          to: fromMe ? remoteJid.replace('@s.whatsapp.net', '') : (sock.user?.id || '').split(':')[0],
          recipientPhone: remoteJid.replace('@s.whatsapp.net', ''),
          text: conversationText,
          message: conversationText,
          sentAt: new Date(msg.messageTimestamp * 1000).toISOString(),
          status: 'DELIVERED',
          direction: fromMe ? 'outgoing' : 'incoming'
        };

        this.recordMessage(safeTenant, record);
      }
    });

    return sessionObj;
  }

  static async disconnect(tenantId) {
    const safeTenant = this.sanitizeTenantId(tenantId);
    const session = this.sessions.get(safeTenant);

    if (session?.sock) {
      try { await session.sock.logout(); } catch {}
      try { session.sock.end(undefined); } catch {}
    }

    this.sessions.delete(safeTenant);
    this.reconnectAttempts.delete(safeTenant);

    const authDir = this.getAuthDirForTenant(safeTenant);
    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}

    return true;
  }
}

export function startWhatsApp(tenantId = MUSTAFA_ABDO_TENANT_ID) {
  return TenantWhatsAppSessionManager.startWhatsApp(tenantId);
}

export const whatsappRouter = express.Router();

function resolveTargetTenant(req, res) {
  const headerTenant = req.headers['x-target-tenant-id'] || req.headers['x-tenant-id'];
  const safe = TenantWhatsAppSessionManager.sanitizeTenantId(headerTenant);
  return safe;
}

whatsappRouter.use((req, res, next) => {
  const headerTenant = req.headers['x-target-tenant-id'] || req.headers['x-tenant-id'];
  req.tenantId = TenantWhatsAppSessionManager.sanitizeTenantId(headerTenant);
  next();
});

whatsappRouter.get('/status', async (req, res) => {
  const tenantId = resolveTargetTenant(req, res);
  if (!tenantId) return;

  let session = TenantWhatsAppSessionManager.getSession(tenantId);

  if (!session) {
    try {
      session = await TenantWhatsAppSessionManager.startWhatsApp(tenantId);
    } catch (e) {
      return res.json({
        tenantId,
        status: 'disconnected',
        qr: '',
        user: null,
        device: null
      });
    }
  }

  const isOnline = session?.sock?.user && session?.connectionState === 'connected';

  const effectiveStatus = isOnline ? 'connected' : (session?.currentQR ? 'qr_ready' : (session?.connectionState || 'disconnected'));

  const qrExpiresIn = session?.qrGeneratedAt 
    ? Math.max(0, Math.round((30000 - (Date.now() - session.qrGeneratedAt)) / 1000))
    : 30;

  const devicePayload = isOnline ? {
    phone: session?.connectedUser?.phone || null,
    pushName: session?.connectedUser?.name || null,
    platform: 'WhatsApp Business (Baileys Live Socket)',
    connectedSince: session?.connectedSince || null
  } : null;

  res.json({
    tenantId,
    status: effectiveStatus,
    qr: effectiveStatus === 'connected' ? '' : (session?.currentQR || ''),
    qrGeneratedAt: session?.qrGeneratedAt || null,
    qrExpiresIn,
    pairingCode: session?.currentPairingCode || '',
    user: isOnline ? session.connectedUser : null,
    device: devicePayload
  });
});

whatsappRouter.post('/pair-code', async (req, res) => {
  try {
    const tenantId = resolveTargetTenant(req, res);
    if (!tenantId) return;

    const { phone, phoneNumber } = req.body;
    const targetPhone = phone || phoneNumber;
    if (!targetPhone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    let cleanPhone = targetPhone.replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('01') && cleanPhone.length === 11) {
      cleanPhone = '2' + cleanPhone;
    }

    let session = TenantWhatsAppSessionManager.getSession(tenantId);
    if (!session?.sock) {
      session = await TenantWhatsAppSessionManager.startWhatsApp(tenantId);
    }

    if (session?.sock?.user || session?.connectionState === 'connected') {
      return res.json({ status: 'connected', code: null, tenantId });
    }

    const startTime = Date.now();
    while ((!session?.sock?.requestPairingCode || (!session?.currentQR && session?.connectionState === 'connecting')) && Date.now() - startTime < 10000) {
      await new Promise(r => setTimeout(r, 500));
      if (session?.sock?.user || session?.connectionState === 'connected') {
        return res.json({ status: 'connected', code: null, tenantId });
      }
    }

    if (!session?.sock?.requestPairingCode) {
      return res.status(503).json({ success: false, error: 'مقبس WhatsApp قيد الإعداد، يرجى المحاولة بعد قليل' });
    }

    const code = await session.sock.requestPairingCode(cleanPhone);
    session.currentPairingCode = code;
    res.json({ success: true, status: 'code_ready', code, tenantId });
  } catch (error) {
    console.error('Error requesting pairing code:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to request pairing code' });
  }
});

whatsappRouter.post('/send', async (req, res) => {
  try {
    const tenantId = resolveTargetTenant(req, res);
    if (!tenantId) return;

    const payload = req.body || {};
    const { recipientPhone, messageText, phone, text, to, message } = payload;
    const targetPhone = recipientPhone || phone || to;
    const targetText = messageText || text || message;

    if (!targetPhone || !targetText) {
      return res.status(400).json({ error: 'recipientPhone and messageText are required' });
    }

    let cleanPhone = targetPhone.replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('01') && cleanPhone.length === 11) {
      cleanPhone = '2' + cleanPhone;
    }
    const formattedJid = `${cleanPhone}@s.whatsapp.net`;

    let session = TenantWhatsAppSessionManager.getSession(tenantId);
    if (!session?.sock || session?.connectionState !== 'connected') {
      try {
        session = await TenantWhatsAppSessionManager.startWhatsApp(tenantId);
      } catch (e) { /* ignore */ }
    }

    if (!session?.sock || session?.connectionState !== 'connected') {
      return res.status(503).json({
        success: false,
        error: 'جلسة واتساب لهذا المكتب غير متصلة، يرجى مسح كود QR أولاً'
      });
    }

    const sent = await session.sock.sendMessage(formattedJid, { text: targetText });

    const msgRecord = {
      id: sent.key.id || `sent_${Date.now()}`,
      tenantId,
      to: cleanPhone,
      recipientPhone: cleanPhone,
      text: targetText,
      message: targetText,
      sentAt: new Date().toISOString(),
      status: 'SENT',
      direction: 'outgoing'
    };

    TenantWhatsAppSessionManager.recordMessage(tenantId, msgRecord);

    res.json({
      success: true,
      tenantId,
      messageId: msgRecord.id,
      recipientPhone: cleanPhone,
      status: 'SENT'
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to send WhatsApp message' });
  }
});

whatsappRouter.post('/disconnect', async (req, res) => {
  try {
    const tenantId = resolveTargetTenant(req, res);
    if (!tenantId) return;

    await TenantWhatsAppSessionManager.disconnect(tenantId);
    res.json({ success: true, tenantId, message: `تم فصل جلسة واتساب بنجاح.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

whatsappRouter.get('/messages', async (req, res) => {
  const tenantId = resolveTargetTenant(req, res);
  if (!tenantId) return;

  let messages = TenantWhatsAppSessionManager.getMessages(tenantId);
  if (messages.length === 0) {
    const hydrated = await fetchCloudMessages(tenantId);
    if (hydrated) messages = hydrated;
  }
  res.json({ success: true, tenantId, messages });
});

export default whatsappRouter;
