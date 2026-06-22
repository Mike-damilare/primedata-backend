// Central config for every country PrimeData supports.
// Add a new country by adding one entry here + (if new provider) wiring that provider's module.

const COUNTRIES = {
  NG: {
    name: 'Nigeria',
    currency: 'NGN',
    symbol: '₦',
    provider: 'vtpass',
    networks: ['MTN', 'GLO', 'AIRTEL', '9MOBILE']
  },
  GH: {
    name: 'Ghana',
    currency: 'GHS',
    symbol: 'GH₵',
    provider: 'reloadly',
    networks: ['MTN', 'VODAFONE', 'AIRTELTIGO']
  },
  KE: {
    name: 'Kenya',
    currency: 'KES',
    symbol: 'KSh',
    provider: 'reloadly',
    networks: ['SAFARICOM', 'AIRTEL']
  },
  ZA: {
    name: 'South Africa',
    currency: 'ZAR',
    symbol: 'R',
    provider: 'reloadly',
    networks: ['VODACOM', 'MTN', 'CELLC', 'TELKOM']
  },
  EG: {
    name: 'Egypt',
    currency: 'EGP',
    symbol: 'E£',
    provider: 'reloadly',
    networks: ['VODAFONE', 'ORANGE', 'ETISALAT']
  }
};

function getCountry(code) {
  return COUNTRIES[(code || '').toUpperCase()] || null;
}

function listCountries() {
  return Object.entries(COUNTRIES).map(([code, c]) => ({
    code, name: c.name, currency: c.currency, symbol: c.symbol, networks: c.networks
  }));
}

module.exports = { COUNTRIES, getCountry, listCountries };
