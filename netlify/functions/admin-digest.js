// Stilte — scheduled founder digest email.
// Runs on the schedule set in netlify.toml. Inert (logs and exits) until both
// RESEND_API_KEY and ADMIN_EMAIL are set in Netlify environment variables.
//
// Required env: RESEND_API_KEY, ADMIN_EMAIL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional env: DIGEST_FROM (defaults to Resend's test sender), ANTHROPIC_API_KEY
//               (adds a short AI summary), DAILY_SPEND_CAP_USD (alert threshold).

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

async function sb(path, options = {}) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;
  const r = await fetch(url, {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!r.ok) throw new Error(`Supabase ${path} ${r.status}: ${await r.text()}`);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('application/json') ? r.json() : null;
}

const money = n => '$' + (Number(n) || 0).toFixed(2);
const esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const since24 = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

async function aiBriefing(stats, errors, feedback) {
  try {
    const lines = [
      `Stats: ${JSON.stringify(stats)}`,
      `New errors (24h): ${errors.map(e => `[${e.context}] ${e.message}`).join(' | ') || 'none'}`,
      `New feedback (24h): ${feedback.map(f => `[${f.kind}] ${f.message}`).join(' | ') || 'none'}`
    ].join('\n');
    const resp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: 'You are briefing the founder of a small Australian health app. In 3-4 sentences, flag anything in the last 24 hours that needs attention and suggest the single most useful next action. Be specific and plain. Australian spelling. Do not invent data.',
        messages: [{ role: 'user', content: lines }]
      })
    });
    if (!resp.ok) return '';
    const d = await resp.json();
    return (d.content && d.content[0] && d.content[0].text) || '';
  } catch (e) {
    console.error('aiBriefing failed:', e.message);
    return '';
  }
}

async function sendEmail(to, subject, html) {
  const from = process.env.DIGEST_FROM || 'Stilte <onboarding@resend.dev>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to, subject, html })
  });
  if (!r.ok) console.error('Resend error:', r.status, await r.text());
}

exports.handler = async function () {
  if (!process.env.RESEND_API_KEY || !process.env.ADMIN_EMAIL) {
    console.log('admin-digest: not configured (RESEND_API_KEY / ADMIN_EMAIL missing) — skipping.');
    return { statusCode: 200, body: 'not configured' };
  }

  let stats = {};
  try {
    const r = await sb('rpc/admin_stats', { method: 'POST', body: JSON.stringify({}) });
    stats = Array.isArray(r) ? r[0] : r;
  } catch (e) { console.error('stats failed:', e.message); }

  let newErrors = [], newFeedback = [];
  try { newErrors = await sb(`app_errors?created_at=gte.${since24()}&select=context,message,created_at&order=created_at.desc&limit=50`) || []; } catch (e) {}
  try { newFeedback = await sb(`feedback?created_at=gte.${since24()}&select=kind,message,created_at&order=created_at.desc&limit=50`) || []; } catch (e) {}

  const cap = Number(process.env.DAILY_SPEND_CAP_USD || 5);
  const alerts = [];
  if (Number(stats.spend_today || 0) >= cap * 0.8) alerts.push(`AI spend today is ${money(stats.spend_today)} of a ${money(cap)} cap.`);
  if (newErrors.length) alerts.push(`${newErrors.length} new error(s) in the last 24h.`);
  const newBugs = newFeedback.filter(f => f.kind === 'bug');
  if (newBugs.length) alerts.push(`${newBugs.length} new bug report(s) in the last 24h.`);

  let briefing = '';
  if (process.env.ANTHROPIC_API_KEY && (newErrors.length || newFeedback.length)) {
    briefing = await aiBriefing(stats, newErrors, newFeedback);
  }

  const stat = (label, val) => `<tr><td style="padding:4px 12px 4px 0;color:#666;">${esc(label)}</td><td style="padding:4px 0;font-weight:600;">${esc(val)}</td></tr>`;
  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#222;">
    <h2 style="font-weight:600;">Stilte — daily digest</h2>
    ${alerts.length ? `<div style="background:#fff4ed;border:1px solid #f0c9ad;border-radius:8px;padding:12px 14px;margin:12px 0;">
      <strong>Needs attention</strong><ul style="margin:6px 0 0;padding-left:18px;">${alerts.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>` : ''}
    ${briefing ? `<p style="line-height:1.5;">${esc(briefing)}</p>` : ''}
    <table style="border-collapse:collapse;font-size:14px;margin-top:8px;">
      ${stat('Total users', stats.total_users)}
      ${stat('Pro / Plus / Trial / Free', `${stats.tier_pro ?? '?'} / ${stats.tier_plus ?? '?'} / ${stats.tier_trial ?? '?'} / ${stats.tier_free ?? '?'}`)}
      ${stat('AI spend today', money(stats.spend_today))}
      ${stat('Spend · 7 / 30 / 365 days', `${money(stats.spend_7d)} / ${money(stats.spend_30d)} / ${money(stats.spend_365d)}`)}
      ${stat('New feedback / open bugs', `${stats.feedback_new ?? '?'} / ${stats.bugs_open ?? '?'}`)}
      ${stat('Errors · 24h / unresolved', `${stats.errors_24h ?? '?'} / ${stats.errors_unresolved ?? '?'}`)}
    </table>
    ${newFeedback.length ? `<h3 style="font-weight:600;margin-top:18px;">New feedback (24h)</h3>
      ${newFeedback.slice(0, 15).map(f => `<p style="margin:6px 0;line-height:1.4;"><span style="color:#888;text-transform:uppercase;font-size:11px;">${esc(f.kind)}</span><br>${esc((f.message || '').slice(0, 300))}</p>`).join('')}` : ''}
    <p style="color:#999;font-size:12px;margin-top:20px;">Open the app's Admin dashboard for the full picture.</p>
  </div>`;

  await sendEmail(process.env.ADMIN_EMAIL, 'Stilte daily digest', html);
  return { statusCode: 200, body: 'sent' };
};
