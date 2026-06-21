'use strict';
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const BASE = 'https://api-checkout.cinetpay.com/v2';
const MIN_WITHDRAWAL = parseInt(process.env.MIN_WITHDRAWAL || '500', 10);
const COMMISSION = parseFloat(process.env.PLATFORM_COMMISSION || '0.20');
const MOMO_FEE = parseFloat(process.env.MOMO_FEE_RATE || '0.015');
const TVA = parseFloat(process.env.TVA_RATE || '0.18');
async function initiatePayment({ amount, description, customerId, customerPhone, returnUrl, notifyUrl }) {
  const tid = uuidv4().replace(/-/g,'').slice(0,20);
  try {
    const { data } = await axios.post(`${BASE}/payment`, { apikey: process.env.CINETPAY_API_KEY, site_id: process.env.CINETPAY_SITE_ID, transaction_id: tid, amount, currency: 'XOF', alternative_currency: '', description, customer_id: customerId, customer_phone_number: customerPhone, customer_city: 'Cotonou', customer_country: 'BJ', customer_state: 'BJ', customer_zip_code: '00229', notify_url: notifyUrl || process.env.CINETPAY_NOTIFY_URL, return_url: returnUrl || '', channels: 'MOBILE_MONEY', lang: 'fr' }, { timeout: 30000 });
    return data.code === '201' ? { success: true, paymentUrl: data.data?.payment_url, transactionId: tid } : { success: false, error: data.message, transactionId: tid };
  } catch (err) { return { success: false, error: err.message, transactionId: tid }; }
}
async function checkPaymentStatus(tid) {
  try {
    const { data } = await axios.post(`${BASE}/payment/check`, { apikey: process.env.CINETPAY_API_KEY, site_id: process.env.CINETPAY_SITE_ID, transaction_id: tid }, { timeout: 15000 });
    return data.code === '00' ? { success: true, status: data.data?.status, amount: data.data?.amount } : { success: false, error: data.message };
  } catch { return { success: false, error: 'Erreur connexion CinetPay' }; }
}
async function initiateTransfer({ amount, phoneNumber, operator }) {
  const tid = uuidv4().replace(/-/g,'').slice(0,20);
  if (amount < MIN_WITHDRAWAL) return { success: false, error: `Minimum ${MIN_WITHDRAWAL} FCFA` };
  try {
    const { data } = await axios.post(`${BASE}/transfer/money/send`, { apikey: process.env.CINETPAY_API_KEY, site_id: process.env.CINETPAY_SITE_ID, transaction_id: tid, amount, currency: 'XOF', client_transaction_id: tid, phone_number: phoneNumber, prefix: '229', wallet_name: operator, description: 'Retrait BeninPlay' }, { timeout: 30000 });
    return data.code === '0' ? { success: true, transactionId: tid } : { success: false, error: data.message, transactionId: tid };
  } catch (err) { return { success: false, error: err.message, transactionId: tid }; }
}
function calculateRevenueSplit(gross) {
  const platformShare = Math.floor(gross * COMMISSION);
  const creatorGross = gross - platformShare;
  const momoFee = Math.ceil(creatorGross * MOMO_FEE);
  return { grossAmount: gross, platformShare, creatorGross, creatorNet: creatorGross - momoFee, momoFee, tva: Math.floor(platformShare * TVA) };
}
module.exports = { initiatePayment, checkPaymentStatus, initiateTransfer, calculateRevenueSplit, MIN_WITHDRAWAL };
