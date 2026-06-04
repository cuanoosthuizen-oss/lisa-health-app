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

  const systemPrompt = type === 'clinical'
    ? `You are summarising a patient's health journal data for their doctor or health team. Be clinical, factual, and concise. Structure your response with clear observations about patterns. Mention recurring symptoms, potential triggers, and anything worth clinical attention. Do not diagnose. Keep it to 4-6 sentences.\n\n${dataDictionary}`
    : `You are a thoughtful health journalling assistant. The user is tracking their wellbeing day-to-day. Look at the patterns in their data and offer one or two grounded observations. Be warm but not effusive. Speak directly to the user. Avoid clinical language unless the data strongly warrants it. Never diagnose, prescribe, or recommend specific treatments. Keep it to 3-4 sentences.\n\n${dataDictionary}`;

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
