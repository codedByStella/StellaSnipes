'use strict';

const nodemailer = require('nodemailer');
const { env } = require('./config');

async function sendEliteAlert(eliteEntries, runTs) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_TO } = env;

  if (!SMTP_USER || !SMTP_PASS || !ALERT_TO) return;
  if (!eliteEntries.length) return;

  const rows = eliteEntries.map(([h, profit, val]) => `
    <tr>
      <td style="padding:8px;font-weight:600;color:#f0f6fc">${h.domain}</td>
      <td style="padding:8px">${h.health_score}/100</td>
      <td style="padding:8px">${profit.toFixed(2)}</td>
      <td style="padding:8px">${h.available ? '✓ Available' : '✗ Registered'}</td>
      <td style="padding:8px">${val ? `$${val.est_mid.toLocaleString()} (${val.confidence})` : 'N/A'}</td>
    </tr>`).join('');

  const html = `
    <html><body style="font-family:sans-serif;background:#0d1117;color:#c9d1d9;padding:20px">
    <h2 style="color:#2ea043">✅ ${eliteEntries.length} ELITE Entry(s) Found</h2>
    <p style="color:#8b949e">Run: ${runTs}</p>
    <table style="border-collapse:collapse;width:100%;margin-top:16px">
      <tr style="background:#161b22;color:#8b949e;font-size:.8rem">
        <th align="left" style="padding:8px">Domain</th>
        <th align="left" style="padding:8px">Health</th>
        <th align="left" style="padding:8px">Score</th>
        <th align="left" style="padding:8px">Available</th>
        <th align="left" style="padding:8px">Estimated Value</th>
      </tr>${rows}
    </table>
    <p style="margin-top:20px;color:#8b949e;font-size:.8rem">Open the application to view the full report.</p>
    </body></html>`;

  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(SMTP_PORT || '587'),
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    await transporter.sendMail({
      from: SMTP_USER,
      to: ALERT_TO,
      subject: `${eliteEntries.length} ELITE Found (${runTs})`,
      html,
    });
  } catch (e) {
    console.error('[!] Email failed:', e.message);
  }
}

module.exports = { sendEliteAlert };
