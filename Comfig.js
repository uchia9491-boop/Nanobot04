import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3000),
  botName: process.env.BOT_NAME || 'NANO BOT',
  dataDir: process.env.DATA_DIR || './data',
  pairingNumber: (process.env.PAIRING_NUMBER || '').replace(/\D/g, ''),
  ownerNumbers: (process.env.OWNER_NUMBERS || '').split(',').map(x => x.replace(/\D/g, '')).filter(Boolean),
  ocrLang: process.env.OCR_LANG || 'eng'
};
