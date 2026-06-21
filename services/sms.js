'use strict';
const AfricasTalking = require('africastalking');
let smsService = null;
function getAT() {
  if (!smsService) {
    const at = AfricasTalking({ apiKey: process.env.AT_API_KEY, username: process.env.AT_USERNAME || 'sandbox' });
    smsService = at.SMS;
  }
  return smsService;
}
async function sendOTP(phone, otp) {
  if (process.env.NODE_ENV !== 'production') { console.log(`[SMS DEV] OTP pour ${phone}: ${otp}`); return { success: true }; }
  try {
    const result = await getAT().send({ to: [phone], message: `Votre code BeninPlay est: ${otp}. Valable 5 minutes.`, from: process.env.AT_SENDER_ID || 'BeninPlay' });
    const r = result.SMSMessageData?.Recipients?.[0];
    return r?.status === 'Success' ? { success: true } : { success: false, error: r?.status };
  } catch (err) { return { success: false, error: err.message }; }
}
function normalizeBeninPhone(phone) {
  const c = phone.replace(/[\s\-]/g, '');
  if (/^\+229\d{8}$/.test(c)) return c;
  if (/^229\d{8}$/.test(c)) return `+${c}`;
  if (/^0\d{8}$/.test(c)) return `+229${c.slice(1)}`;
  if (/^\d{8}$/.test(c)) return `+229${c}`;
  return null;
}
module.exports = { sendOTP, normalizeBeninPhone };
