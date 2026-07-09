'use strict';

// Envoi d'emails transactionnels via Brevo (ex-Sendinblue) — gratuit jusqu'à
// ~300 emails/jour. Configuré par BREVO_API_KEY + BREVO_SENDER (email vérifié).
// Sans clé, l'envoi est ignoré (le code est alors renvoyé à l'app pour les tests).
async function sendVerificationCode(email, code) {
  const key = process.env.BREVO_API_KEY;
  const sender = process.env.BREVO_SENDER || 'no-reply@beninplay.app';
  if (!key) return { sent: false, reason: 'no_api_key' };
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': key,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: 'BeninPlay', email: sender },
        to: [{ email }],
        subject: 'Votre code de vérification BeninPlay',
        htmlContent:
          `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
             <h2 style="color:#00C853">BeninPlay</h2>
             <p>Voici votre code de vérification :</p>
             <p style="font-size:30px;font-weight:bold;letter-spacing:8px;color:#111">${code}</p>
             <p style="color:#666">Ce code expire dans 10 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
           </div>`,
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error('[Brevo] échec envoi', r.status, t);
      return { sent: false, reason: 'brevo_error' };
    }
    return { sent: true };
  } catch (e) {
    console.error('[Brevo] erreur', e.message);
    return { sent: false, reason: 'exception' };
  }
}

module.exports = { sendVerificationCode };
