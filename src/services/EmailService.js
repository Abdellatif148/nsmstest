/**
 * EmailService.js — Transactional emails via Resend
 * Free tier: 3,000 emails/month — resend.com
 * npm install resend
 */
const { Resend } = require('resend')
const logger = require('../config/logger')

// AFTER — only initializes when first email is actually sent
let _resend = null
const getResend = () => {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is not set in environment variables')
    }
    _resend = new Resend(process.env.RESEND_API_KEY)
  }
  return _resend
}
const FROM = process.env.EMAIL_FROM || 'Nook SMS <noreply@nook.ma>'

// ─── WELCOME EMAIL ──────────────────────────────────────────
async function sendWelcome(client) {
  const maskedKey = client.api_key.substring(0, 20) + '...'
  await resend.emails.send({
    from: FROM,
    to: client.email,
    subject: `Bienvenue sur Nook SMS — Votre clé API est prête`,
    html: buildTemplate({
      title: `Bienvenue, ${client.name} 👋`,
      intro: `Votre compte Nook SMS est actif. Voici tout ce dont vous avez besoin pour commencer.`,
      body: `
        <div style="background:#f8f9ff;border:1px solid #e8eaf0;border-radius:10px;padding:20px;margin:20px 0;font-family:monospace;font-size:14px">
          <div style="color:#666;font-size:11px;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Votre clé API (conservez-la secrètement)</div>
          <div style="color:#f97316;font-weight:700;word-break:break-all">${client.api_key}</div>
        </div>
        <div style="background:#fff8f0;border-left:3px solid #f97316;padding:12px 16px;border-radius:0 8px 8px 0;margin:16px 0;font-size:13px;color:#666">
          ⚠️ Stockez cette clé dans vos variables d'environnement. Elle ne sera plus affichée après cet email.
        </div>
        <div style="margin:20px 0">
          <div style="font-weight:600;margin-bottom:10px">Pour envoyer votre premier SMS :</div>
          <div style="background:#0a0f1e;border-radius:8px;padding:16px;font-family:monospace;font-size:13px;color:#98c379">
            curl -X POST https://api.nook.ma/v1/sms/send \\<br>
            &nbsp;&nbsp;-H "Authorization: Bearer ${maskedKey}" \\<br>
            &nbsp;&nbsp;-d '{"to":"+212612345678","message":"Bonjour!"}'
          </div>
        </div>
        <div style="display:flex;gap:10px;margin-top:24px">
          <div style="flex:1;background:#f8f9ff;border-radius:8px;padding:14px;text-align:center">
            <div style="font-size:20px">📖</div>
            <div style="font-size:13px;font-weight:600;margin-top:6px">Documentation</div>
            <div style="font-size:12px;color:#888;margin-top:3px"><a href="https://dashboard.nook.ma/docs" style="color:#f97316">dashboard.nook.ma/docs</a></div>
          </div>
          <div style="flex:1;background:#f8f9ff;border-radius:8px;padding:14px;text-align:center">
            <div style="font-size:20px">💬</div>
            <div style="font-size:13px;font-weight:600;margin-top:6px">Support</div>
            <div style="font-size:12px;color:#888;margin-top:3px"><a href="mailto:support@nook.ma" style="color:#f97316">support@nook.ma</a></div>
          </div>
          <div style="flex:1;background:#f8f9ff;border-radius:8px;padding:14px;text-align:center">
            <div style="font-size:20px">📊</div>
            <div style="font-size:13px;font-weight:600;margin-top:6px">Dashboard</div>
            <div style="font-size:12px;color:#888;margin-top:3px"><a href="https://dashboard.nook.ma" style="color:#f97316">dashboard.nook.ma</a></div>
          </div>
        </div>
      `,
      cta: { text: 'Accéder au Dashboard →', url: 'https://dashboard.nook.ma' },
      footer: `Plan actuel: ${client.plan} | Crédits: ${client.credits} DH`
    })
  })
  logger.info(`Welcome email sent to ${client.email}`)
}

// ─── LOW CREDITS WARNING ────────────────────────────────────
async function sendLowCreditsWarning(client) {
  await resend.emails.send({
    from: FROM,
    to: client.email,
    subject: `⚠️ Crédits faibles — Rechargez votre compte Nook SMS`,
    html: buildTemplate({
      title: `⚠️ Vos crédits sont presque épuisés`,
      intro: `Il vous reste seulement <strong style="color:#f97316">${client.credits} DH</strong> de crédits — environ ${Math.floor(client.credits / 0.2)} SMS restants.`,
      body: `
        <div style="background:#fff8f0;border:1px solid #fed7aa;border-radius:10px;padding:20px;margin:16px 0;text-align:center">
          <div style="font-size:36px;font-weight:800;color:#f97316">${client.credits} DH</div>
          <div style="color:#666;margin-top:4px">≈ ${Math.floor(client.credits / 0.2)} messages restants</div>
          <div style="margin-top:12px;width:100%;height:6px;background:#f0e8e0;border-radius:3px;overflow:hidden">
            <div style="height:100%;background:linear-gradient(90deg,#f97316,#fb923c);width:${Math.min((client.credits / 500) * 100, 100)}%;border-radius:3px"></div>
          </div>
        </div>
        <p style="color:#555;font-size:14px">Pour recharger votre compte, effectuez un virement bancaire à :</p>
        <div style="background:#f8f9ff;border-radius:8px;padding:16px;font-size:13px;line-height:2">
          <strong>Bénéficiaire:</strong> Nook Tech SARL<br>
          <strong>Banque:</strong> CIH Bank<br>
          <strong>Référence:</strong> ${client.email}
        </div>
        <p style="color:#888;font-size:12px;margin-top:12px">Puis envoyez un email à <a href="mailto:billing@nook.ma" style="color:#f97316">billing@nook.ma</a> avec votre reçu de virement.</p>
      `,
      cta: { text: 'Recharger mes crédits →', url: 'https://dashboard.nook.ma' }
    })
  })
  logger.info(`Low credits warning sent to ${client.email}`)
}

// ─── PASSWORD RESET ─────────────────────────────────────────
async function sendPasswordReset(client, resetToken) {
  const resetUrl = `https://dashboard.nook.ma/reset-password?token=${resetToken}`
  await resend.emails.send({
    from: FROM,
    to: client.email,
    subject: `Réinitialisation de votre mot de passe Nook SMS`,
    html: buildTemplate({
      title: `Réinitialisez votre mot de passe`,
      intro: `Vous avez demandé la réinitialisation de votre mot de passe. Ce lien expire dans 1 heure.`,
      body: `
        <p style="color:#555;font-size:14px">Si vous n'avez pas fait cette demande, ignorez cet email — votre mot de passe ne changera pas.</p>
        <div style="background:#fff8f0;border-left:3px solid #f97316;padding:12px 16px;border-radius:0 8px 8px 0;margin:16px 0;font-size:13px;color:#666">
          ⏰ Ce lien expire dans <strong>1 heure</strong>
        </div>
      `,
      cta: { text: 'Réinitialiser mon mot de passe →', url: resetUrl }
    })
  })
}

// ─── INVOICE EMAIL ──────────────────────────────────────────
async function sendInvoice(client, invoice) {
  await resend.emails.send({
    from: FROM,
    to: client.email,
    subject: `Facture ${invoice.reference} — Nook SMS`,
    attachments: invoice.pdfBuffer ? [{
      filename: `Facture-${invoice.reference}.pdf`,
      content: invoice.pdfBuffer.toString('base64'),
      type: 'application/pdf'
    }] : [],
    html: buildTemplate({
      title: `Votre facture est disponible`,
      intro: `La facture <strong>${invoice.reference}</strong> pour ${invoice.period} est disponible.`,
      body: `
        <div style="background:#f8f9ff;border:1px solid #e8eaf0;border-radius:10px;padding:20px;margin:16px 0">
          <div style="display:flex;justify-content:space-between;margin-bottom:8px">
            <span style="color:#666">Référence:</span>
            <strong>${invoice.reference}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;margin-bottom:8px">
            <span style="color:#666">Période:</span>
            <strong>${invoice.period}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;margin-bottom:8px">
            <span style="color:#666">Montant HT:</span>
            <strong>${invoice.ht_amount} DH</strong>
          </div>
          <div style="display:flex;justify-content:space-between;border-top:1px solid #e8eaf0;padding-top:8px;margin-top:8px">
            <span style="color:#333;font-weight:600">Total TTC:</span>
            <strong style="color:#f97316;font-size:16px">${invoice.ttc_amount} DH</strong>
          </div>
        </div>
        <p style="color:#555;font-size:13px">La facture PDF est jointe à cet email.</p>
      `,
      cta: { text: 'Voir dans le dashboard →', url: 'https://dashboard.nook.ma' }
    })
  })
}

// ─── CREDITS ADDED ──────────────────────────────────────────
async function sendCreditsAdded(client, amount, newBalance) {
  await resend.emails.send({
    from: FROM,
    to: client.email,
    subject: `✅ ${amount} DH crédités sur votre compte Nook SMS`,
    html: buildTemplate({
      title: `Crédits ajoutés avec succès !`,
      intro: `<strong style="color:#10b981">${amount} DH</strong> ont été ajoutés à votre compte.`,
      body: `
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:20px;margin:16px 0;text-align:center">
          <div style="font-size:36px;font-weight:800;color:#10b981">+${amount} DH</div>
          <div style="color:#666;margin-top:4px">Nouveau solde: <strong>${newBalance} DH</strong></div>
          <div style="color:#888;font-size:12px;margin-top:4px">≈ ${Math.floor(newBalance / 0.2).toLocaleString()} messages disponibles</div>
        </div>
      `,
      cta: { text: 'Envoyer des SMS →', url: 'https://dashboard.nook.ma' }
    })
  })
}

// ─── API KEY ROTATED ────────────────────────────────────────
async function sendKeyRotated(client, newKey) {
  await resend.emails.send({
    from: FROM,
    to: client.email,
    subject: `🔑 Votre clé API Nook SMS a été régénérée`,
    html: buildTemplate({
      title: `Nouvelle clé API générée`,
      intro: `Votre clé API a été régénérée avec succès. L'ancienne clé est désormais invalide.`,
      body: `
        <div style="background:#f8f9ff;border:1px solid #e8eaf0;border-radius:10px;padding:20px;margin:20px 0">
          <div style="color:#666;font-size:11px;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Nouvelle clé API</div>
          <div style="color:#f97316;font-weight:700;font-family:monospace;word-break:break-all">${newKey}</div>
        </div>
        <div style="background:#fef2f2;border-left:3px solid #ef4444;padding:12px 16px;border-radius:0 8px 8px 0;margin:16px 0;font-size:13px;color:#666">
          🚨 Mettez à jour toutes vos applications avec cette nouvelle clé immédiatement. L'ancienne clé ne fonctionne plus.
        </div>
      `,
      cta: { text: 'Accéder au Dashboard →', url: 'https://dashboard.nook.ma' }
    })
  })
}

// ─── OTP VERIFICATION EMAIL (backup) ───────────────────────
async function sendOTPBackup(email, code) {
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: `${code} — Votre code de vérification Nook SMS`,
    html: buildTemplate({
      title: `Code de vérification`,
      intro: `Votre code de vérification est :`,
      body: `
        <div style="text-align:center;margin:24px 0">
          <div style="font-size:48px;font-weight:800;letter-spacing:8px;color:#f97316">${code}</div>
          <div style="color:#888;font-size:13px;margin-top:8px">Valide 10 minutes</div>
        </div>
        <div style="background:#fff8f0;border-left:3px solid #f97316;padding:12px 16px;border-radius:0 8px 8px 0;font-size:13px;color:#666">
          🔒 Ne partagez jamais ce code. Nook SMS ne vous demandera jamais votre code.
        </div>
      `
    })
  })
}

// ─── RESELLER WELCOME ───────────────────────────────────────
async function sendResellerWelcome(reseller) {
  await resend.emails.send({
    from: FROM,
    to: reseller.email,
    subject: `🎉 Votre compte Revendeur Nook SMS est actif`,
    html: buildTemplate({
      title: `Bienvenue dans le programme Revendeur !`,
      intro: `Votre compte revendeur est activé. Vous pouvez maintenant créer des sous-comptes pour vos clients.`,
      body: `
        <div style="background:#f8f9ff;border-radius:10px;padding:20px;margin:16px 0">
          <div style="font-weight:600;margin-bottom:10px">Vos avantages revendeur :</div>
          <div style="display:flex;flex-direction:column;gap:8px;font-size:13px;color:#555">
            <div>✓ Prix de gros: <strong>0.15 DH/SMS</strong> (au lieu de 0.20 DH)</div>
            <div>✓ Créez des sous-comptes pour vos clients</div>
            <div>✓ Définissez vos propres prix de revente</div>
            <div>✓ Dashboard revendeur dédié</div>
            <div>✓ Commission sur chaque SMS de vos clients</div>
          </div>
        </div>
      `,
      cta: { text: 'Accéder au portail Revendeur →', url: 'https://dashboard.nook.ma/reseller' }
    })
  })
}

// ─── MONTHLY REPORT ─────────────────────────────────────────
async function sendMonthlyReport(client, stats) {
  await resend.emails.send({
    from: FROM,
    to: client.email,
    subject: `📊 Rapport mensuel Nook SMS — ${stats.month}`,
    html: buildTemplate({
      title: `Rapport mensuel — ${stats.month}`,
      intro: `Voici un résumé de votre activité SMS pour ${stats.month}.`,
      body: `
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin:16px 0">
          ${[
            { label: 'SMS envoyés', value: stats.sent.toLocaleString(), color: '#f97316' },
            { label: 'Taux livraison', value: stats.delivery_rate, color: '#10b981' },
            { label: 'Dépensé', value: stats.cost_dh + ' DH', color: '#3b82f6' }
          ].map(s => `
            <div style="background:#f8f9ff;border-radius:8px;padding:14px;text-align:center">
              <div style="font-size:22px;font-weight:800;color:${s.color}">${s.value}</div>
              <div style="font-size:11px;color:#888;margin-top:3px">${s.label}</div>
            </div>
          `).join('')}
        </div>
        <div style="margin-top:16px;font-size:13px;color:#555">
          <strong>Solde actuel:</strong> ${client.credits} DH (≈ ${Math.floor(client.credits / 0.2).toLocaleString()} SMS)
        </div>
      `,
      cta: { text: 'Voir l\'analyse complète →', url: 'https://dashboard.nook.ma/analytics' }
    })
  })
}

// ─── HTML TEMPLATE BUILDER ──────────────────────────────────
function buildTemplate({ title, intro, body, cta, footer }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:'Plus Jakarta Sans',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
        <!-- HEADER -->
        <tr><td style="background:linear-gradient(135deg,#0a0f1e,#111520);border-radius:14px 14px 0 0;padding:24px 32px;text-align:center">
          <div style="display:inline-flex;align-items:center;gap:10px">
            <div style="width:36px;height:36px;background:linear-gradient(135deg,#f97316,#fb923c);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;color:white">N</div>
            <span style="font-size:18px;font-weight:800;color:white">Nook SMS</span>
          </div>
        </td></tr>
        <!-- ORANGE BAR -->
        <tr><td style="height:3px;background:linear-gradient(90deg,#f97316,#fb923c)"></td></tr>
        <!-- BODY -->
        <tr><td style="background:white;padding:32px;border-radius:0 0 14px 14px">
          <h1 style="font-size:22px;font-weight:800;color:#111;margin:0 0 8px">${title}</h1>
          <p style="font-size:15px;color:#555;margin:0 0 20px;line-height:1.6">${intro}</p>
          ${body || ''}
          ${cta ? `
            <div style="text-align:center;margin:28px 0 20px">
              <a href="${cta.url}" style="background:linear-gradient(135deg,#f97316,#fb923c);color:white;text-decoration:none;padding:14px 28px;border-radius:10px;font-size:15px;font-weight:700;display:inline-block">${cta.text}</a>
            </div>
          ` : ''}
          ${footer ? `<p style="font-size:12px;color:#999;border-top:1px solid #f0f0f0;padding-top:16px;margin-top:16px">${footer}</p>` : ''}
        </td></tr>
        <!-- FOOTER -->
        <tr><td style="text-align:center;padding:20px;color:#aaa;font-size:12px;line-height:1.8">
          Nook Tech SARL • Maroc<br>
          <a href="https://dashboard.nook.ma" style="color:#f97316;text-decoration:none">dashboard.nook.ma</a> •
          <a href="mailto:support@nook.ma" style="color:#f97316;text-decoration:none">support@nook.ma</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

module.exports = {
  sendWelcome, sendLowCreditsWarning, sendPasswordReset,
  sendInvoice, sendCreditsAdded, sendKeyRotated,
  sendOTPBackup, sendResellerWelcome, sendMonthlyReport
}
