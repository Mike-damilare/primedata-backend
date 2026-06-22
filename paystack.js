const fetch = require('node-fetch');

const MOCK = process.env.MOCK_MODE === 'true';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const BASE = 'https://api.paystack.co';

// Initialize a payment - returns an authorization_url to redirect/pop up
async function initializePayment({ email, amount, reference, metadata }) {
  if (MOCK) {
    return {
      status: true,
      data: {
        authorization_url: `mock://paystack/checkout?ref=${reference}`,
        access_code: 'mock_access_code',
        reference
      }
    };
  }
  const res = await fetch(`${BASE}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email,
      amount: Math.round(amount * 100), // kobo
      reference,
      metadata
    })
  });
  return res.json();
}

// Verify a payment by reference
async function verifyPayment(reference) {
  if (MOCK) {
    return {
      status: true,
      data: { status: 'success', reference, gateway_response: 'Successful (mock)' }
    };
  }
  const res = await fetch(`${BASE}/transaction/verify/${reference}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
  });
  return res.json();
}

module.exports = { initializePayment, verifyPayment };
