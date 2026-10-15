import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import pino from 'pino';
import makeWASocket, {
  DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState,
  jidNormalizedUser, downloadMediaMessage
} from '@whiskeysockets/baileys';
import { config } from './config.js';
import { openDatabase, getSettings, saveSettings } from './src/database.js';
import { handleCommand } from './src/commands.js';
import { containsLink, mediaKind } from './src/security.js';
import { extractReceiptText } from './src/ocr.js';

fs.mkdirSync(config.dataDir, { recursive: true });
const authDir = path.join(config.dataDir, 'auth_info');
fs.mkdirSync(authDir, { recursive: true });
const db = openDatabase(config.dataDir);
const app = express();
app.get('/health', (_req,res)=>res.json({ok:true, name:config.botName, time:new Date().toISOString()}));
app.get('/', (_req,res)=>res.send(`${config.botName} está a executar.`));
app.listen(config.port, ()=>console.log(`Health server ativo na porta ${config.port}`));

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
let sock;
let connecting = false;

function phoneFromJid(jid='') {
  const bare = jid.split('@')[0].split(':')[0];
  return /^\d+$/.test(bare) ? bare : '';
}
function getText(message) {
  const m = message?.message;
  if (!m) return '';
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption ||
    m.videoMessage?.caption || m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId || m.listResponseMessage?.singleSelectReply?.selectedRowId || '';
}
function unwrapMessage(message) {
  let m = message;
  for (let i=0; i<5 && m; i++) {
    const next = m.ephemeralMessage?.message || m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message;
    if (!next) break;
    m = { ...m, message: next };
  }
  return m;
}
function quotedParticipant(msg) {
  const context = msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo || msg.message?.videoMessage?.contextInfo;
  return context?.participant ? jidNormalizedUser(context.participant) : null;
}
function mentionedJids(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

async function startSocket() {
  if (connecting) return;
  connecting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
      version, logger, auth: state, printQRInTerminal: false,
      browser: ['NANO BOT','Chrome','1.0.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async update => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) logger.info('QR recebido, mas não será apresentado. Utilize emparelhamento por código.');
      if (connection === 'connecting') logger.info('A ligar ao WhatsApp...');
      if (connection === 'open') logger.info('NANO BOT ligado ao WhatsApp.');
      if (connection === 'close') {
        connecting = false;
        const status = lastDisconnect?.error?.output?.statusCode;
        if (status !== DisconnectReason.loggedOut) {
          logger.warn({status}, 'Ligação fechada; nova tentativa em breve.');
          setTimeout(startSocket, 3000);
        } else {
          logger.error('Sessão terminada. Remova a sessão antiga apenas se quiser emparelhar de novo.');
        }
      }
    });

    if (!state.creds.registered && config.pairingNumber) {
      // Dar tempo para o socket estabelecer ligação antes do pedido de código.
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(config.pairingNumber);
          logger.info(`PAIRING CODE: ${code}`);
          logger.info('Introduza este código em WhatsApp > Dispositivos associados > Associar com número de telefone.');
        } catch (e) {
          logger.error({err:e}, 'Não foi possível obter código de emparelhamento.');
        }
      }, 2500);
    } else if (!state.creds.registered) {
      logger.warn('Defina PAIRING_NUMBER com o número internacional sem + para obter o código de emparelhamento.');
    }

    sock.ev.on('group-participants.update', async event => {
      try {
        if (event.action !== 'add') return;
        const settings = getSettings(db,event.id);
        if (!settings.welcome) return;
        const metadata = await sock.groupMetadata(event.id);
        for (const user of event.participants || []) {
          const welcome = settings.welcomeText || '👋 Bem-vindo(a) ao grupo!';
          await sock.sendMessage(event.id,{text:welcome.replace('{membro}',`@${user.split('@')[0]}`),mentions:[user]});
          const phone=phoneFromJid(user);
          db.prepare(`INSERT INTO members(jid,user_jid,phone,name) VALUES(?,?,?,?)
            ON CONFLICT(jid,user_jid) DO UPDATE SET phone=excluded.phone`).run(event.id,user,phone,phone);
        }
      } catch(e) { logger.warn({err:e},'Erro ao enviar boas-vindas'); }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const original of messages) {
        try {
          if (!original.message || original.key.fromMe) continue;
          const msg = unwrapMessage(original);
          const jid = msg.key.remoteJid;
          if (!jid?.endsWith('@g.us')) continue;
          const sender = jidNormalizedUser(msg.key.participant || msg.participant || '');
          const text = getText(msg);
          const metadata = await sock.groupMetadata(jid);
          const participant = metadata.participants.find(p => jidNormalizedUser(p.id) === sender);
          const isAdmin = Boolean(participant?.admin || participant?.isAdmin || config.ownerNumbers.includes(phoneFromJid(sender)));
          const botJid = jidNormalizedUser(sock.user?.id || '');
          const botParticipant = metadata.participants.find(p=>jidNormalizedUser(p.id)===botJid);
          const isBotAdmin = Boolean(botParticipant?.admin || botParticipant?.isAdmin);
          const context = msg.message?.extendedTextMessage?.contextInfo ||
            msg.message?.imageMessage?.contextInfo || msg.message?.videoMessage?.contextInfo ||
            msg.message?.documentMessage?.contextInfo;
          const quotedJid = context?.participant ? jidNormalizedUser(context.participant) : null;
          const mentions = mentionedJids(msg).map(jidNormalizedUser);
          const senderPhone = phoneFromJid(sender);
          const senderName = msg.pushName || senderPhone || sender;
          db.prepare(`INSERT INTO members(jid,user_jid,phone,name) VALUES(?,?,?,?)
            ON CONFLICT(jid,user_jid) DO UPDATE SET phone=excluded.phone,name=excluded.name`).run(jid,sender,senderPhone,senderName);

          const settings = getSettings(db,jid);
          const kind = mediaKind(msg);

          // Antilink: remover a mensagem quando possível. Não envia resposta para evitar spam.
          if (settings.antilink && containsLink(text) && isBotAdmin) {
            await sock.sendMessage(jid,{delete:msg.key});
            continue;
          }
          if (kind && ((kind==='foto' && settings.antifoto) || (kind==='video' && settings.antivideo) || (kind==='audio' && settings.antiaudio))) {
            if (isBotAdmin) await sock.sendMessage(jid,{delete:msg.key});
            continue;
          }

          // Possível comprovativo: OCR em imagem ou documento. O resultado fica pendente.
          if (settings.detector && (kind==='foto' || kind==='documento')) {
            const mimetype = msg.message?.imageMessage?.mimetype || msg.message?.documentMessage?.mimetype || '';
            if (kind==='foto' || /pdf|image/i.test(mimetype)) {
              try {
                const buffer = await downloadMediaMessage(msg,'buffer',{}, { logger, reuploadRequest: sock.updateMediaMessage });
                if (Buffer.isBuffer(buffer) && buffer.length < 12 * 1024 * 1024) {
                  const extracted = await extractReceiptText(buffer,config.ocrLang);
                  const result = db.prepare(`INSERT INTO receipts(group_jid,user_jid,media_type,extracted_text,amount,reference,receipt_date)
                    VALUES(?,?,?,?,?,?,?)`).run(jid,sender,kind,extracted.text,extracted.amount,extracted.reference,extracted.date);
                  const admins = metadata.participants.filter(p=>p.admin||p.isAdmin).map(p=>jidNormalizedUser(p.id));
                  const report = `🧾 *POSSÍVEL COMPROVATIVO #${result.lastInsertRowid}*\\nMembro: @${sender.split('@')[0]}\\nValor OCR: ${extracted.amount}\\nReferência OCR: ${extracted.reference}\\nData OCR: ${extracted.date}\\n\\n⚠️ OCR não confirma pagamento. Verifique a transação na conta e responda: .confirmarpagamento ${result.lastInsertRowid} ou .rejeitarpagamento ${result.lastInsertRowid}`;
                  for (const admin of admins) await sock.sendMessage(jid,{text:report,mentions:[sender]});
                }
              } catch(e) { logger.warn({err:e},'Falha no OCR do possível comprovativo'); }
            }
          }

          // Confirmação manual do comprovativo, só administradores.
          if (/^\.confirmarpagamento\s+\d+/i.test(text) || /^\.rejeitarpagamento\s+\d+/i.test(text)) {
            if (!isAdmin) continue;
            const id = Number(text.match(/\d+/)?.[0]);
            const status = text.toLowerCase().startsWith('.confirmar') ? 'confirmed_by_admin' : 'rejected_by_admin';
            const res = db.prepare('UPDATE receipts SET status=? WHERE id=? AND group_jid=? AND status="pending"').run(status,id,jid);
            await sock.sendMessage(jid,{text:res.changes ? `Comprovativo #${id}: ${status}. Confirmação registada manualmente.` : 'Comprovativo pendente não encontrado.'},{quoted:msg});
            continue;
          }

          const handled = await handleCommand({
            sock, db, msg, jid, sender, senderPhone, senderName, text, isAdmin,
            isBotAdmin, quotedJid, mentions, config, groupMetadata: metadata
          });
          if (handled) continue;
        } catch(e) {
          logger.error({err:e},'Erro ao processar mensagem');
        }
      }
    });
  } catch(e) {
    connecting = false;
    logger.error({err:e},'Falha ao iniciar socket');
    setTimeout(startSocket,5000);
  }
}
startSocket();

// Verifica alarmes a cada minuto. O servidor deve permanecer ligado.
setInterval(async () => {
  try {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const dateKey = now.toISOString().slice(0,16);
    const alarms = db.prepare('SELECT * FROM alarms WHERE enabled=1 AND time=? AND (last_run IS NULL OR last_run<>?)').all(hhmm,dateKey);
    for (const alarm of alarms) {
      try {
        await sock.groupSettingUpdate(alarm.group_jid,alarm.action==='abrir'?'not_announcement':'announcement');
        db.prepare('UPDATE alarms SET last_run=? WHERE id=?').run(dateKey,alarm.id);
        await sock.sendMessage(alarm.group_jid,{text:alarm.action==='abrir'?'⏰ Grupo aberto automaticamente.':'⏰ Grupo fechado automaticamente.'});
      } catch(e) { logger.warn({err:e,alarm:alarm.id},'Falha ao executar alarme'); }
    }
  } catch(e) { logger.warn({err:e},'Erro ao verificar alarmes'); }
},60000);
    
