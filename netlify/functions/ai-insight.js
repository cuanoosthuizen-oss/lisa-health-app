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

  console.log('Function invoked. Method:', event.httpMethod);
  console.log('API key present:', !!process.env.ANTHROPIC_API_KEY);

  try {
    const { data, type } = JSON.parse(event.body);
    console.log('Request type:', type || 'default');

    const dataDictionary = `CRITICAL - HOW TO READ THE DATA:

All numeric health scores use the SAME scale direction where HIGHER = BETTER and LOWER = WORSE.

- wellbeing: 1 = very poor, 10 = feeling great
- heart: 1 = severe symptoms, 10 = no heart issues
- spinal: 1 = severe pain, 10 = no pain
- headache: 1 = severe, 10 = no headache
- stomach: 1 = very bad, 10 = stomach feels great
- gut: 1 = very bad, 10 = gut feels great
- libido: 1 = very low desire for intimacy, 10 = high desire
- sexual_health: free-text tags about physical sexual symptoms (e.g. pain during/after intimacy, discomfort). Empty or "Not applicable" means nothing logged — do not infer anything from an empty value.
- menstrual_comfort: 1 = severe pain, 10 = no pain, 0 = N/A (NOT menstruating that day). EXCLUDE all 0 values from any menstrual analysis.
- cycle_day: which day of menstrual cycle (1 = first day of period)
- red_flag: true if she flagged the day as concerning

INTERPRETATION EXAMPLES:
- wellbeing=8 means she felt great
- wellbeing=3 means she felt poor
- stomach=2 means very bad stomach issues
- stomach=9 means stomach felt great
- menstrual_comfort=8 means barely any pain (good day)
- menstrual_comfort=2 means severe pain (bad day)
- menstrual_comfort=0 means she was NOT menstruating, ignore for menstrual analysis

Never describe a high score as a problem or a low score as good. Re-read the scale above if uncertain.`;

    const systemPrompt = type === 'clinical'
      ? `You are summarising a patient's health journal data for their doctor or health team. Be clinical, factual, and concise. Structure your response with clear observations about patterns. Mention recurring symptoms, potential triggers, and anything worth clinical attention. Do not diagnose. Keep it to 4-6 sentences.

${dataDictionary}`
      : `You are a compassionate health data analyst reviewing daily health journal entries for a woman named Lisa. Identify patterns, potential triggers, and notable trends. Speak directly to Lisa in second person. Never give medical diagnoses. Keep your response to 3-4 short sentences. Focus on what the data actually shows.

${dataDictionary}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: data }]
      })
    });

    console.log('Anthropic response status:', response.status);
    const result = await response.json();

    if (!response.ok) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          insight: `Anthropic API error (${response.status}): ${result.error?.message || JSON.stringify(result)}`
        })
      };
    }

    const text = result.content?.[0]?.text || 'Unable to generate insight.';

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ insight: text })
    };
  } catch (err) {
    console.error('Function error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
