const fetch = require('node-fetch');

const MOCK = process.env.MOCK_MODE === 'true';
const RELOADLY_CLIENT_ID = process.env.RELOADLY_CLIENT_ID;
const RELOADLY_CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET;
const RELOADLY_AUTH_URL = 'https://auth.reloadly.com/oauth/token';
const RELOADLY_API_URL = process.env.RELOADLY_API_URL || 'https://topups-sandbox.reloadly.com';

// Sample data plans per country/network — swap for live Reloadly /operators lookup once on real keys
const DATA_PLANS = {
  GH: {
    MTN: [
      { code: 'gh-mtn-1gb', name: '1GB - 30 Days', price: 15 },
      { code: 'gh-mtn-3gb', name: '3GB - 30 Days', price: 35 }
    ],
    VODAFONE: [{ code: 'gh-voda-1gb', name: '1GB - 30 Days', price: 16 }],
    AIRTELTIGO: [{ code: 'gh-at-1gb', name: '1GB - 30 Days', price: 14 }]
  },
  KE: {
    SAFARICOM: [
      { code: 'ke-saf-1gb', name: '1GB - 30 Days', price: 100 },
      { code: 'ke-saf-3gb', name: '3GB - 30 Days', price: 250 }
    ],
    AIRTEL: [{ code: 'ke-air-1gb', name: '1GB - 30 Days', price: 90 }]
  },
  ZA: {
    VODACOM: [{ code: 'za-voda-1gb', name: '1GB - 30 Days', price: 99 }],
    MTN: [{ code: 'za-mtn-1gb', name: '1GB - 30 Days', price: 95 }],
    CELLC: [{ code: 'za-cellc-1gb', name: '1GB - 30 Days', price: 89 }],
    TELKOM: [{ code: 'za-telkom-1gb', name: '1GB - 30 Days', price: 85 }]
  },
  EG: {
    VODAFONE: [{ code: 'eg-voda-1gb', name: '1GB - 30 Days', price: 50 }],
    ORANGE: [{ code: 'eg-orange-1gb', name: '1GB - 30 Days', price: 48 }],
    ETISALAT: [{ code: 'eg-etisalat-1gb', name: '1GB - 30 Days', price: 50 }]
  }
};

function getDataPlans(countryCode, network) {
  const country = DATA_PLANS[countryCode?.toUpperCase()];
  if (!country) return [];
  return country[network?.toUpperCase()] || [];
}

async function getAccessToken() {
  if (MOCK) return 'mock_token';
  const res = await fetch(RELOADLY_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: RELOADLY_CLIENT_ID,
      client_secret: RELOADLY_CLIENT_SECRET,
      grant_type: 'client_credentials',
      audience: RELOADLY_API_URL
    })
  });
  const data = await res.json();
  return data.access_token;
}

async function buyAirtime({ countryCode, network, phone, amount, requestId }) {
  if (MOCK) {
    return {
      code: '000',
      status: 'SUCCESSFUL',
      requestId,
      content: { status: 'delivered', product_name: `${network} Airtime (${countryCode})`, amount }
    };
  }
  const token = await getAccessToken();
  const res = await fetch(`${RELOADLY_API_URL}/topups`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operatorId: network, // in live mode, resolve real operatorId via /operators/auto-detect
      amount,
      useLocalAmount: true,
      recipientPhone: { countryCode, number: phone },
      customIdentifier: requestId
    })
  });
  const data = await res.json();
  return { code: data.status === 'SUCCESSFUL' ? '000' : '001', ...data };
}

async function buyData({ countryCode, network, phone, planCode, requestId }) {
  if (MOCK) {
    return {
      code: '000',
      status: 'SUCCESSFUL',
      requestId,
      content: { status: 'delivered', product_name: `${network} Data - ${planCode} (${countryCode})` }
    };
  }
  // Live mode: Reloadly data bundles use fixed-amount topups tied to a specific operator product id.
  const token = await getAccessToken();
  const res = await fetch(`${RELOADLY_API_URL}/topups`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operatorId: planCode,
      recipientPhone: { countryCode, number: phone },
      customIdentifier: requestId
    })
  });
  const data = await res.json();
  return { code: data.status === 'SUCCESSFUL' ? '000' : '001', ...data };
}

module.exports = { buyAirtime, buyData, getDataPlans, DATA_PLANS };
