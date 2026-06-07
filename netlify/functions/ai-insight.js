// ============================================================================
// Stilte — AI Insight Function (v0.5.0 — Session 2.5)
// ============================================================================
// Adds:
//   - Per-user monthly cap enforcement (tier-based)
//   - Per-date insight caching (return cached if it exists)
//   - Global daily circuit breaker
//   - Token-based cost tracking
//
// Required env vars:
//   - ANTHROPIC_API_KEY (existing)
//   - SUPABASE_URL (existing)
//   - SUPABASE_SERVICE_ROLE_KEY (NEW — bypass RLS for tier/usage tables)
//
// Request body shape (NEW):
//   {
//     userId: 'uuid',          // required — used for cap enforcement
//     entryDate: 'YYYY-MM-DD', // required for 'daily' type — caching key
//     type: 'daily' | 'clinical',  // default 'daily'
//     data: '...'              // the prompt content (as before)
//   }
//
// Response (success):
//   { content, fromCache: bool, usage: { used, cap, tier, effectiveCap } }
//
// Response (cap/circuit-breaker):
//   { error: 'cap_reached' | 'circuit_breaker' | ..., usage }
//   HTTP 429 (cap) or 503 (circuit breaker)
// ============================================================================

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// Pricing per million tokens (USD). Keep in sync if models change.
const MODEL_PRICING = {
  'claude-haiku-4-5': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 }
};

// Tier configuration — single source of truth.
const TIER_CONFIG = {
  free:  { monthlyCap: 0,  model: 'claude-haiku-4-5'  },
  plus:  { monthlyCap: 31, model: 'claude-haiku-4-5'  },
  pro:   { monthlyCap: 31, model: 'claude-sonnet-4-6' }
};

// Global daily spend cap (USD). Circuit breaker threshold.
const DAILY_SPEND_CAP_USD = 5.00;

// New users get a 14-day Pro trial from signup, then fall back to free.
const TRIAL_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

// Founder account allowed to run the cross-user feedback digest. Verified from the
// caller's access token server-side — never trusted from the request body.
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || '9bcc86eb-4475-4dea-b296-110ee4eac331';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function json(statusCode, body) {
  return { statusCode, headers: corsHeaders, body: JSON.stringify(body) };
}

// Minimal Supabase REST client (service-role auth, bypasses RLS)
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
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Supabase ${path} ${r.status}: ${txt}`);
  }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('application/json') ? r.json() : null;
}

function currentYearMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function todayDateUtc() {
  return new Date().toISOString().slice(0, 10);
}

// Resolve a user's effective tier. Paid tiers win; otherwise new users are on
// the Pro trial for their first 14 days (keyed off the auth signup date), then
// fall back to free. Fails closed (free) if anything can't be read.
async function resolveTier(userId) {
  let subTier = 'free', extraStd = 0, extraAdv = 0;
  try {
    const rows = await sb(`user_tiers?user_id=eq.${userId}&select=tier,extra_credits_standard,extra_credits_advanced`);
    if (rows && rows[0]) {
      subTier = rows[0].tier || 'free';
      extraStd = rows[0].extra_credits_standard || 0;
      extraAdv = rows[0].extra_credits_advanced || 0;
    }
  } catch (e) { console.error('Tier lookup failed:', e.message); }

  let inTrial = false;
  if (subTier !== 'plus' && subTier !== 'pro') {
    try {
      const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      });
      if (r.ok) {
        const u = await r.json();
        const created = u && u.created_at ? Date.parse(u.created_at) : NaN;
        if (!isNaN(created)) inTrial = (Date.now() - created) < TRIAL_DAYS_MS;
      }
    } catch (e) { console.error('Trial (created_at) lookup failed:', e.message); }
  }

  const effectiveTier = (subTier === 'plus' || subTier === 'pro')
    ? subTier
    : (inTrial ? 'pro' : 'free');
  return { subTier, effectiveTier, inTrial, extraStd, extraAdv };
}

// Verify the caller from their Supabase access token (not from the request body).
// Returns the authenticated user id, or null if the token is missing/invalid.
async function verifyCaller(event) {
  const h = event.headers || {};
  const authHeader = h.authorization || h.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return null;
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${token}`
      }
    });
    if (!r.ok) return null;
    const u = await r.json();
    return (u && u.id) ? u.id : null;
  } catch (e) {
    console.error('verifyCaller failed:', e.message);
    return null;
  }
}

// Founder-only: summarise all submitted feedback into themes + a prioritised shortlist.
// Verifies the caller's token against the admin id; does not touch any user's AI cap.
async function handleFeedbackDigest(event, body) {
  const callerId = await verifyCaller(event);
  if (!callerId || callerId !== ADMIN_USER_ID) {
    return json(403, { error: 'forbidden' });
  }

  const date = (body && body.date) || new Date().toISOString().slice(0, 10);
  const generate = !!(body && body.generate);

  // Return the saved digest for this day if one exists.
  try {
    const saved = await sb(`feedback_digests?digest_date=eq.${date}&select=content,total,distinct_users`);
    if (saved && saved.length) {
      const row = saved[0];
      return json(200, { summary: row.content, total: row.total, distinctUsers: row.distinct_users, date, cached: true });
    }
  } catch (e) {
    console.error('Digest read failed:', e.message);
  }

  // Nothing saved and not asked to generate → just report that.
  if (!generate) {
    return json(200, { summary: null, date });
  }

  let rows = [];
  try {
    rows = await sb('feedback?select=kind,message,status,created_at,user_id&order=created_at.desc&limit=1000') || [];
  } catch (e) {
    console.error('Feedback read failed:', e.message);
    return json(502, { error: 'feedback_read_failed' });
  }

  if (!rows.length) {
    return json(200, { summary: 'No feedback has been submitted yet.', total: 0, distinctUsers: 0, date });
  }

  const distinctUsers = new Set(rows.map(r => r.user_id)).size;

  // Anonymise: the model sees a short opaque tag per user, never the real id.
  const tag = {};
  let n = 0;
  const lines = rows.map(r => {
    if (!(r.user_id in tag)) { n += 1; tag[r.user_id] = 'U' + n; }
    const d = (r.created_at || '').slice(0, 10);
    const msg = (r.message || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    return `[${tag[r.user_id]} | ${r.kind} | ${d}] ${msg}`;
  }).join('\n');

  const systemPrompt = `You are helping the founder of a small Australian health-tracking app triage user feedback. You will be given a list of feedback items, one per line, tagged with an anonymous user id, a type, and a date.

Produce a concise, practical briefing for the founder:
1. The main themes, each with how many distinct users raised it (use the Uxx tags to count).
2. Bugs and problems, kept separate from feature requests, kept separate from praise.
3. A short prioritised shortlist of what to act on next, with one line of reasoning each. Weight by how many users raised it and how easy it sounds to address.

Be specific and quote short fragments where useful. Do not invent feedback that isn't there. Keep it tight — this is a working triage note, not an essay. Use Australian spelling.`;

  let apiResponse;
  try {
    const resp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Here is the feedback (${rows.length} items from ${distinctUsers} people):\n\n${lines}` }]
      })
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.error('Anthropic digest error:', resp.status, txt);
      return json(502, { error: 'anthropic_error' });
    }
    apiResponse = await resp.json();
  } catch (e) {
    console.error('Anthropic digest call failed:', e.message);
    return json(502, { error: 'anthropic_call_failed' });
  }

  const summary = apiResponse.content && apiResponse.content[0] && apiResponse.content[0].text;
  if (!summary) return json(502, { error: 'no_content_in_response' });

  // Save (upsert) this day's digest so it isn't regenerated on every view.
  try {
    await sb('feedback_digests?on_conflict=digest_date', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ digest_date: date, content: summary, total: rows.length, distinct_users: distinctUsers })
    });
  } catch (e) {
    console.error('Digest save failed:', e.message);
  }

  return json(200, { summary, total: rows.length, distinctUsers, date });
}

// Founder-only: aggregate stats via the locked-down admin_stats() RPC (service role).
async function handleAdminOverview(event) {
  const callerId = await verifyCaller(event);
  if (!callerId || callerId !== ADMIN_USER_ID) {
    return json(403, { error: 'forbidden' });
  }
  try {
    const r = await sb('rpc/admin_stats', { method: 'POST', body: JSON.stringify({}) });
    const stats = Array.isArray(r) ? r[0] : r;
    return json(200, { stats: stats || {} });
  } catch (e) {
    console.error('admin_overview failed:', e.message);
    return json(502, { error: 'stats_failed' });
  }
}

// Founder-only: most recent errors plus bug-type feedback.
async function handleAdminErrors(event) {
  const callerId = await verifyCaller(event);
  if (!callerId || callerId !== ADMIN_USER_ID) {
    return json(403, { error: 'forbidden' });
  }
  try {
    const errors = await sb('app_errors?select=id,source,context,message,app_version,created_at,resolved&order=created_at.desc&limit=50') || [];
    const bugs = await sb('feedback?kind=eq.bug&select=id,message,status,admin_note,created_at&order=created_at.desc&limit=50') || [];
    return json(200, { errors, bugs });
  } catch (e) {
    console.error('admin_errors failed:', e.message);
    return json(502, { error: 'errors_failed' });
  }
}

const FEEDBACK_STATUSES = ['new', 'ready', 'planned', 'actioned', 'dismissed'];

// Founder-only: list feedback items (optionally filtered by status) for triage.
async function handleFeedbackList(event, body) {
  const callerId = await verifyCaller(event);
  if (!callerId || callerId !== ADMIN_USER_ID) return json(403, { error: 'forbidden' });
  const status = body && body.status;
  let q = 'feedback?select=id,kind,message,status,admin_note,app_version,created_at&order=created_at.desc&limit=200';
  if (status && status !== 'all' && FEEDBACK_STATUSES.includes(status)) {
    q += `&status=eq.${status}`;
  }
  try {
    const rows = await sb(q) || [];
    return json(200, { items: rows });
  } catch (e) {
    console.error('feedback_list failed:', e.message);
    return json(502, { error: 'list_failed' });
  }
}

// Founder-only: update a feedback item's status and/or private note.
async function handleFeedbackUpdate(event, body) {
  const callerId = await verifyCaller(event);
  if (!callerId || callerId !== ADMIN_USER_ID) return json(403, { error: 'forbidden' });
  const id = body && body.id;
  if (!id) return json(400, { error: 'missing_id' });
  const patch = {};
  if (body.status !== undefined) {
    if (!FEEDBACK_STATUSES.includes(body.status)) return json(400, { error: 'bad_status' });
    patch.status = body.status;
  }
  if (body.note !== undefined) {
    patch.admin_note = (body.note === null || body.note === '') ? null : String(body.note).slice(0, 2000);
  }
  if (!Object.keys(patch).length) return json(400, { error: 'nothing_to_update' });
  try {
    await sb(`feedback?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch)
    });
    return json(200, { ok: true });
  } catch (e) {
    console.error('feedback_update failed:', e.message);
    return json(502, { error: 'update_failed' });
  }
}

// Founder-only: mark an error resolved / unresolved.
async function handleErrorUpdate(event, body) {
  const callerId = await verifyCaller(event);
  if (!callerId || callerId !== ADMIN_USER_ID) return json(403, { error: 'forbidden' });
  const id = body && body.id;
  if (!id) return json(400, { error: 'missing_id' });
  try {
    await sb(`app_errors?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ resolved: !!body.resolved })
    });
    return json(200, { ok: true });
  } catch (e) {
    console.error('error_update failed:', e.message);
    return json(502, { error: 'update_failed' });
  }
}

// Best-effort server-side error logging into app_errors.
async function logServerError(context, err, userId) {
  try {
    await sb('app_errors', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: userId || null,
        source: 'server',
        context: String(context).slice(0, 200),
        message: (err && err.message ? err.message : String(err)).slice(0, 1000),
        stack: (err && err.stack ? err.stack : '').slice(0, 4000)
      })
    });
  } catch (e) {
    console.error('logServerError failed:', e.message);
  }
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'invalid_body' });
  }

  const { userId, entryDate, type = 'daily', data: prompt } = body;

  // Founder-only feedback digest. Identity comes from the verified token, not the body.
  if (type === 'feedback_digest') {
    return await handleFeedbackDigest(event, body);
  }
  if (type === 'admin_overview') {
    return await handleAdminOverview(event);
  }
  if (type === 'admin_errors') {
    return await handleAdminErrors(event);
  }
  if (type === 'feedback_list') {
    return await handleFeedbackList(event, body);
  }
  if (type === 'feedback_update') {
    return await handleFeedbackUpdate(event, body);
  }
  if (type === 'error_update') {
    return await handleErrorUpdate(event, body);
  }

  if (!userId) return json(400, { error: 'missing_user_id' });

  // File analysis (Pro) — separate path: no prompt, no monthly insight cap.
  if (type === 'extract_file') {
    return await handleFileExtraction(userId, body);
  }
  if (!prompt) return json(400, { error: 'missing_prompt' });
  if (type === 'daily' && !entryDate) {
    return json(400, { error: 'missing_entry_date_for_daily_insight' });
  }

  // STEP 1: Resolve effective tier (paid → trial → free) and allowance.
  const tierInfo = await resolveTier(userId);
  const tier = tierInfo.effectiveTier;
  const extraCreditsStandard = tierInfo.extraStd;
  const extraCreditsAdvanced = tierInfo.extraAdv;
  const tierConfig = TIER_CONFIG[tier] || TIER_CONFIG.free;

  const isAdvanced = tierConfig.model === 'claude-sonnet-4-6';
  const extraCredits = isAdvanced ? extraCreditsAdvanced : extraCreditsStandard;
  const effectiveCap = tierConfig.monthlyCap + extraCredits;

  // No paid plan, no active trial, no credits → no AI. Refuse server-side so
  // the gate holds even if the endpoint is called directly.
  if (effectiveCap <= 0) {
    return json(403, {
      error: 'upgrade_required',
      message: 'AI features need a paid plan, an active trial, or insight credits.',
      usage: { used: 0, cap: 0, tier }
    });
  }

  // STEP 2: Cache lookup (daily only)
  if (type === 'daily' && entryDate) {
    try {
      const cached = await sb(`ai_insights?user_id=eq.${userId}&entry_date=eq.${entryDate}&insight_type=eq.daily&select=content`);
      if (cached && cached[0]) {
        const usage = await getUsageSummary(userId, tier, tierConfig, extraCreditsStandard, extraCreditsAdvanced);
        return json(200, { content: cached[0].content, fromCache: true, usage });
      }
    } catch (e) {
      console.error('Cache lookup failed (continuing):', e.message);
    }
  }

  // STEP 3: Circuit breaker
  const today = todayDateUtc();
  try {
    const spendRows = await sb(`ai_spend_daily?spend_date=eq.${today}&select=spend_usd,tripped_at`);
    const todaySpend = spendRows && spendRows[0] ? Number(spendRows[0].spend_usd) : 0;
    if (todaySpend >= DAILY_SPEND_CAP_USD) {
      return json(503, {
        error: 'circuit_breaker',
        message: 'AI insights temporarily unavailable. Try again tomorrow.',
        usage: await getUsageSummary(userId, tier, tierConfig, extraCreditsStandard, extraCreditsAdvanced)
      });
    }
  } catch (e) {
    console.error('Circuit breaker check failed:', e.message);
    return json(503, { error: 'circuit_breaker_check_failed' });
  }

  // STEP 4: Monthly cap check
  const yearMonth = currentYearMonth();
  let used = 0;
  try {
    const usageRows = await sb(`ai_usage?user_id=eq.${userId}&year_month=eq.${yearMonth}&select=insight_count`);
    used = usageRows && usageRows[0] ? usageRows[0].insight_count : 0;
  } catch (e) {
    console.error('Usage lookup failed:', e.message);
    return json(500, { error: 'usage_check_failed' });
  }

  if (used >= effectiveCap) {
    return json(429, {
      error: 'cap_reached',
      message: 'Monthly insight limit reached.',
      usage: { used, cap: effectiveCap, tier, extraCredits }
    });
  }

  // STEP 5: Call Anthropic
  const dataDictionary = `HOW TO READ THE DATA:

The user defines their own metrics. Each metric's name, type, and direction are given in the message — rely on those, not on assumptions.

- Respect each metric's stated direction. "higher_better": a higher number is better. "lower_better": a higher number is worse (e.g. pain, anxiety). "neutral": treat the number as descriptive, neither good nor bad.
- Not every metric is a 1-10 score. Metrics may also be yes/no, a number with a unit, free text, or a list of tags. A "cyclical" metric (such as a menstrual cycle day) describes position within a cycle, not severity — never read it as good or bad.
- Only discuss the metrics present in the data. Never invent metrics, values, or measurements, and never assume a direction that wasn't given.`;

  const dailyPrompt = `You are reviewing a person's own health journal the way an experienced, caring GP would when a patient brings in their own tracking. Your job is to genuinely help them make sense of it — not to read numbers back to them.

How to think:
- Lead with the one or two things that actually matter in this period. Do not summarise every metric.
- Interpret rather than recite: what has changed, what stands out, what is steady, what is worth noticing.
- Be honest about uncertainty. If there is little data, a short window, or a lot of variability, say so plainly rather than forcing an observation. "There isn't quite enough here yet to say much, but X is worth keeping an eye on" is far better than a hollow pattern.
- Where the data genuinely supports it, note a possible connection gently — as something they might look at, never as cause and effect.
- When something would be worth watching, or worth mentioning to their own doctor, say so briefly.

Boundaries (these matter):
- This is a perspective to help them reflect, NOT medical advice. Never diagnose, never name a condition they might have, never prescribe or suggest specific treatments, doses, or supplements.
- Never alarm or catastrophise. Stay calm and grounded.
- Use only the metrics and values present in the data. Never invent anything or assume a direction you were not given.

Voice: warm, plain-spoken, human and calm — a trusted clinician who actually listens. Speak directly to the person as "you". Write one short, focused paragraph of roughly 3 to 5 sentences. No headings, no bullet points, no preamble such as "Based on your data".

The two examples below show the right VOICE and judgement only. Do not copy their content — everything you write must come from this user's actual data:
- "Your sleep has held steadier this fortnight, and your better-rested days have tended to be your calmer ones too. Energy is the one still swinging about — there isn't enough yet to see why, so it's worth watching over the next week or two."
- "It's early days, only a handful of entries, so I'd hold off reading much into the ups and downs for now. The one thing worth a gentle note is that your headache days and your lower-water days have lined up more than once — not a rule, just something you might keep half an eye on."

${dataDictionary}`;

  const clinicalPrompt = `You are preparing a concise, neutral summary of a patient's self-tracked health journal for their doctor or care team to read in under a minute. Write the way a careful clinician notes observations for a colleague.

- Be factual and structured: lead with the clearest, most clinically relevant observations — recurring symptoms, notable changes across the period, medication adherence, and any associations the data suggests (stated as associations, not causes).
- Quantify where it helps (averages, number of days, direction of change), but do not list every metric.
- State honestly where the data is too sparse or variable for a pattern to be reliable.
- Do NOT diagnose, stage, or suggest treatment. Flag what may warrant clinical attention and leave the judgement to the clinician.
- Plain clinical language, roughly 4 to 6 sentences. Use only metrics present in the data.

${dataDictionary}`;

  const systemPrompt = type === 'clinical' ? clinicalPrompt : dailyPrompt;

  let apiResponse;
  try {
    const resp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: tierConfig.model,
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.error('Anthropic API error:', resp.status, txt);
      return json(502, { error: 'anthropic_error', detail: txt });
    }
    apiResponse = await resp.json();
  } catch (e) {
    console.error('Anthropic call failed:', e.message);
    await logServerError('insight_' + type, e, userId);
    return json(502, { error: 'anthropic_call_failed' });
  }

  const content = apiResponse.content && apiResponse.content[0] && apiResponse.content[0].text;
  if (!content) {
    return json(502, { error: 'no_content_in_response' });
  }

  // STEP 6: Calculate cost
  const inputTokens = apiResponse.usage?.input_tokens || 0;
  const outputTokens = apiResponse.usage?.output_tokens || 0;
  const pricing = MODEL_PRICING[tierConfig.model];
  const callCostUsd = pricing
    ? (inputTokens * pricing.input / 1_000_000) + (outputTokens * pricing.output / 1_000_000)
    : 0;

  // STEP 7: Record results (best-effort)
  if (type === 'daily' && entryDate) {
    try {
      await sb('ai_insights', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          user_id: userId,
          entry_date: entryDate,
          insight_type: 'daily',
          content,
          model_used: tierConfig.model
        })
      });
    } catch (e) {
      console.error('Insight save failed (non-fatal):', e.message);
    }
  }

  try {
    const existing = await sb(`ai_usage?user_id=eq.${userId}&year_month=eq.${yearMonth}&select=id,insight_count`);
    if (existing && existing[0]) {
      await sb(`ai_usage?id=eq.${existing[0].id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          insight_count: existing[0].insight_count + 1,
          updated_at: new Date().toISOString()
        })
      });
    } else {
      await sb('ai_usage', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          user_id: userId,
          year_month: yearMonth,
          insight_count: 1
        })
      });
    }
  } catch (e) {
    console.error('Usage increment failed (non-fatal):', e.message);
  }

  if (used >= tierConfig.monthlyCap && extraCredits > 0) {
    try {
      const decrementField = isAdvanced ? 'extra_credits_advanced' : 'extra_credits_standard';
      await sb(`user_tiers?user_id=eq.${userId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          [decrementField]: extraCredits - 1,
          updated_at: new Date().toISOString()
        })
      });
    } catch (e) {
      console.error('Credit decrement failed (non-fatal):', e.message);
    }
  }

  try {
    const spendRows = await sb(`ai_spend_daily?spend_date=eq.${today}&select=spend_usd,call_count`);
    if (spendRows && spendRows[0]) {
      const newSpend = Number(spendRows[0].spend_usd) + callCostUsd;
      const tripped = newSpend >= DAILY_SPEND_CAP_USD;
      await sb(`ai_spend_daily?spend_date=eq.${today}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          spend_usd: newSpend,
          call_count: spendRows[0].call_count + 1,
          tripped_at: tripped ? new Date().toISOString() : null,
          updated_at: new Date().toISOString()
        })
      });
    } else {
      await sb('ai_spend_daily', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          spend_date: today,
          spend_usd: callCostUsd,
          call_count: 1
        })
      });
    }
  } catch (e) {
    console.error('Spend tracking failed (non-fatal):', e.message);
  }

  const usage = await getUsageSummary(userId, tier, tierConfig, extraCreditsStandard, extraCreditsAdvanced);
  return json(200, { content, fromCache: false, usage });
};

// ============================================================================
// File extraction (Pro): summarise one uploaded document and store the text.
// Body: { userId, type:'extract_file', fileId }
// The function pulls the file from Storage itself (service role) so large
// files never hit Netlify's request-size limit, then writes the summary back.
// ============================================================================
async function handleFileExtraction(userId, body) {
  const { fileId } = body;
  if (!fileId) return json(400, { error: 'missing_file_id' });

  const markStatus = async (status, extra = {}) => {
    try {
      await sb(`medical_files?id=eq.${fileId}&user_id=eq.${userId}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ extract_status: status, ...extra })
      });
    } catch (e) { console.error('markStatus err:', e.message); }
  };

  // Pro gate (the 14-day trial counts as Pro)
  const tierInfo = await resolveTier(userId);
  if (tierInfo.effectiveTier !== 'pro') return json(403, { error: 'not_pro', message: 'File analysis is a Pro feature.' });

  // Look up the file row (scoped to this user)
  let row;
  try {
    const rows = await sb(`medical_files?id=eq.${fileId}&user_id=eq.${userId}&select=storage_path,mime_type,file_name,size_bytes`);
    row = rows && rows[0];
  } catch (e) { console.error('file lookup failed:', e.message); }
  if (!row) return json(404, { error: 'file_not_found' });

  const mimeType = row.mime_type || '';
  const isImage = mimeType.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';
  if (!isImage && !isPdf) { await markStatus('failed'); return json(400, { error: 'unsupported_type' }); }

  // Global circuit breaker
  const today = todayDateUtc();
  try {
    const spendRows = await sb(`ai_spend_daily?spend_date=eq.${today}&select=spend_usd`);
    const todaySpend = spendRows && spendRows[0] ? Number(spendRows[0].spend_usd) : 0;
    if (todaySpend >= DAILY_SPEND_CAP_USD) {
      return json(503, { error: 'circuit_breaker', message: 'AI temporarily unavailable. Try again tomorrow.' });
    }
  } catch (e) {
    console.error('Circuit breaker (extract) failed:', e.message);
    return json(503, { error: 'circuit_breaker_check_failed' });
  }

  // Download the file from Storage (service role) and base64-encode server-side
  let base64;
  try {
    const fr = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/medical-files/${row.storage_path}`, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    if (!fr.ok) throw new Error('storage ' + fr.status);
    const buf = Buffer.from(await fr.arrayBuffer());
    base64 = buf.toString('base64');
  } catch (e) {
    console.error('file download failed:', e.message);
    await markStatus('failed');
    return json(502, { error: 'file_download_failed' });
  }

  const model = TIER_CONFIG.pro.model;
  const fileBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } };

  const extractSystem = `You are extracting a health-related document (such as a blood test, pathology report, scan report, or letter from a clinician) into a faithful plain-text summary. This summary is stored alongside the user's own health journal and may later be shown to their doctor.

Rules:
- Transcribe the key clinical content factually: test/marker names, the user's values with units, the reference range for each where shown, and the collection or report date if present.
- Clearly note any result the document itself marks as outside its reference range (high/low/abnormal). Do not invent flags the document does not show.
- Do not diagnose, infer causes, or give treatment advice. State only what the document contains.
- If the document is unreadable or is not a health record, reply with one short sentence saying so and nothing else.
- Plain text only, no markdown tables. Use short labelled lines. Keep under ~400 words.`;

  const userText = `Extract and summarise this document${row.file_name ? ` (filename: ${row.file_name})` : ''}.`;

  let apiResponse;
  try {
    const resp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: extractSystem,
        messages: [{ role: 'user', content: [ fileBlock, { type: 'text', text: userText } ] }]
      })
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.error('Anthropic extract error:', resp.status, txt);
      await markStatus('failed');
      return json(502, { error: 'anthropic_error', detail: txt });
    }
    apiResponse = await resp.json();
  } catch (e) {
    console.error('Anthropic extract call failed:', e.message);
    await markStatus('failed');
    return json(502, { error: 'anthropic_call_failed' });
  }

  const textBlock = apiResponse.content && apiResponse.content.find(b => b.type === 'text');
  const content = textBlock ? textBlock.text : null;
  if (!content) { await markStatus('failed'); return json(502, { error: 'no_content_in_response' }); }

  await markStatus('done', { extracted_text: content, extracted_at: new Date().toISOString() });

  // Record spend (best-effort) on the shared daily ledger
  const inputTokens = apiResponse.usage?.input_tokens || 0;
  const outputTokens = apiResponse.usage?.output_tokens || 0;
  const pricing = MODEL_PRICING[model];
  const callCostUsd = pricing ? (inputTokens * pricing.input / 1_000_000) + (outputTokens * pricing.output / 1_000_000) : 0;
  try {
    const spendRows = await sb(`ai_spend_daily?spend_date=eq.${today}&select=spend_usd,call_count`);
    if (spendRows && spendRows[0]) {
      const newSpend = Number(spendRows[0].spend_usd) + callCostUsd;
      await sb(`ai_spend_daily?spend_date=eq.${today}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          spend_usd: newSpend,
          call_count: spendRows[0].call_count + 1,
          tripped_at: newSpend >= DAILY_SPEND_CAP_USD ? new Date().toISOString() : null,
          updated_at: new Date().toISOString()
        })
      });
    } else {
      await sb('ai_spend_daily', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ spend_date: today, spend_usd: callCostUsd, call_count: 1 })
      });
    }
  } catch (e) { console.error('Spend tracking (extract) failed (non-fatal):', e.message); }

  return json(200, { content });
}

async function getUsageSummary(userId, tier, tierConfig, extraStd, extraAdv) {
  const yearMonth = currentYearMonth();
  let used = 0;
  try {
    const usageRows = await sb(`ai_usage?user_id=eq.${userId}&year_month=eq.${yearMonth}&select=insight_count`);
    used = usageRows && usageRows[0] ? usageRows[0].insight_count : 0;
  } catch (e) {
    console.error('Usage summary lookup failed:', e.message);
  }
  const isAdvanced = tierConfig.model === 'claude-sonnet-4-6';
  return {
    used,
    cap: tierConfig.monthlyCap,
    tier,
    extraCreditsStandard: extraStd,
    extraCreditsAdvanced: extraAdv,
    effectiveCap: tierConfig.monthlyCap + (isAdvanced ? extraAdv : extraStd)
  };
}
