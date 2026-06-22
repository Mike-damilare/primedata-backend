const fetch = require('node-fetch');

const MOCK = process.env.MOCK_MODE === 'true';
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// Sends a WhatsApp message back to the user. In mock mode this just logs/returns —
// in live mode it calls Meta's WhatsApp Cloud API.
async function sendMessage(to, text) {
  if (MOCK) {
    console.log(`[WhatsApp MOCK] -> ${to}: ${text}`);
    return { mocked: true, to, text };
  }
  const res = await fetch(`https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    })
  });
  return res.json();
}

// Parses simple commands like "RECHARGE 500 MTN" or "BUY 1GB MTN" or "BALANCE"
function parseCommand(text) {
  const parts = text.trim().toUpperCase().split(/\s+/);
  const command = parts[0];

  if (command === 'BALANCE') return { command: 'BALANCE' };

  if (command === 'RECHARGE' && parts.length >= 3) {
    return { command: 'RECHARGE', amount: Number(parts[1]), network: parts[2] };
  }

  if (command === 'BUY' && parts.length >= 3) {
    return { command: 'BUY_DATA', planHint: parts[1], network: parts[2] };
  }

  return { command: 'UNKNOWN' };
}

module.exports = { sendMessage, parseCommand };
