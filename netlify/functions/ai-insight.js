exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  try {
    const { data, type } = JSON.parse(event.body);

    const systemPrompt = type === 'clinical'
      ? `You are summarising a patient's health journal data for their doctor or health team. Be clinical, factual, and concise. Mention recurring symptoms, potential triggers, and anything worth clinical attention. Do not diagnose. Keep it to 4-6 sentences.`
      : `You are a compassionate health data analyst reviewing daily health journal entries for a woman named Lisa. Identify patterns, potential triggers, and notable trends. Speak directly to Lisa in second person. Never give medical diagnoses. Keep your response to 3-4 short sentences. Focus on what the data actually shows.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: data }]
      })
    });

    const result = await response.json();
    const text = result.content?.[0]?.text || 'Unable to generate insight.';

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ insight: text })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
