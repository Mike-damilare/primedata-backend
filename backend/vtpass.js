const fetch = require('node-fetch');

const MOCK = process.env.MOCK_MODE === 'true';
const VTPASS_URL = process.env.VTPASS_API_URL;
const USERNAME = process.env.VTPASS_USERNAME;
const PASSWORD = process.env.VTPASS_PASSWORD;
const API_KEY = process.env.VTPASS_API_KEY;
const SECRET_KEY = process.env.VTPASS_SECRET_KEY;

// Network service IDs on VTpass
const AIRTIME_SERVICE = { MTN: 'mtn', GLO: 'glo', AIRTEL: 'airtel', '9MOBILE': 'etisalat' };
const DATA_SERVICE = { MTN: 'mtn-data', GLO: 'glo-data', AIRTEL: 'airtel-data', '9MOBILE': 'etisalat-data' };

// Sample data plans (replace with live VTpass /service-variations lookup once on real keys)
const DATA_PLANS = {
  MTN: [
    { code: 'mtn-1gb-30d', name: '1GB - 30 Days', price: 350 },
    { code: 'mtn-2gb-30d', name: '2GB - 30 Days', price: 700 },
    { code: 'mtn-5gb-30d', name: '5GB - 30 Days', price: 1700 }
  ],
  GLO: [
    { code: 'glo-1gb-30d', name: '1GB - 30 Days', price: 300 },
    { code: 'glo-2gb-30d', name: '2GB - 30 Days', price: 600 }
  ],
  AIRTEL: [
    { code: 'airtel-1gb-30d', name: '1GB - 30 Days', price: 320 },
    { code: 'airtel-2gb-30d', name: '2GB - 30 Days', price: 650 }
  ],
  '9MOBILE': [
    { code: '9mobile-1gb-30d', name: '1GB - 30 Days', price: 300 }
  ]
};

function getDataPlans(network) {
  return DATA_PLANS[network] || [];
}

async function buyAirtime({ network, phone, amount, requestId }) {
  if (MOCK) {
    return {
      code: '000',
      response_description: 'TRANSACTION SUCCESSFUL (mock)',
      requestId,
      content: { transactions: { status: 'delivered', product_name: `${network} Airtime`, amount } }
    };
  }
  const res = await fetch(`${VTPASS_URL}/pay`, {
    method: 'POST',
    headers: {
      'api-key': API_KEY,
      'secret-key': SECRET_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      request_id: requestId,
      serviceID: AIRTIME_SERVICE[network],
      amount,
      phone
    })
  });
  return res.json();
}

async function buyData({ network, phone, planCode, requestId }) {
  if (MOCK) {
    return {
      code: '000',
      response_description: 'TRANSACTION SUCCESSFUL (mock)',
      requestId,
      content: { transactions: { status: 'delivered', product_name: `${network} Data - ${planCode}` } }
    };
  }
  const res = await fetch(`${VTPASS_URL}/pay`, {
    method: 'POST',
    headers: {
      'api-key': API_KEY,
      'secret-key': SECRET_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      request_id: requestId,
      serviceID: DATA_SERVICE[network],
      billersCode: phone,
      variation_code: planCode,
      phone
    })
  });
  return res.json();
}

module.exports = { buyAirtime, buyData, getDataPlans, DATA_PLANS };
