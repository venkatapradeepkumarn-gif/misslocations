// Netlify Function: the AI helper for Check Char Finder.
// It keeps your Anthropic API key on the server and only lets the page ask
// stockroom-location questions with a fixed prompt, fixed tools and a capped answer length.
//
// Environment variables (Netlify > Site configuration > Environment variables):
//   ANTHROPIC_API_KEY  required. Your key from console.anthropic.com
//   ACCESS_CODE        optional. If set, people must type this code to use the AI helper.
//   MODEL              optional. Defaults to claude-haiku-5-5 (fast and cheap).

const SYSTEM = [
  'You help a colleague in a retail stockroom find stock that may have been voiced to the wrong shelf with a voice headset.',
  'How locations work: standard shelves are aisle (2 digits) + bay letter + shelf letter, e.g. 40JH is read "FOUR ZERO JULIET HOTEL". J = jewellery and S = security (one digit then bay and shelf, e.g. J5IM). Bulk is Z + 2-digit aisle + letter (Z41K = "FOUR ONE BULK KILO"), linbin is L + 2-digit aisle + letter, CA = cash office, CP = collection point.',
  'Every location has a check character (a phonetic word). When voicing stock, the colleague says the location, then the check character printed on the shelf label; the headset only accepts it if that check character belongs to the location it heard. So stock can only end up booked to a location whose check character matches the one spoken. It can also physically be on a different shelf than the one it is booked to if someone read the wrong label.',
  'Never work out a check character yourself. Use the facts in the message and call the tools for any other location.',
  'Answer with: a short prioritised list of up to 6 places to check, most likely first, each as "- CODE: reason" in a few words; then one line of practical advice. Under 140 words, plain text, no headings. Write location codes exactly as codes (40JH, Z14K) so the app can make them tappable. If the question is not about stock locations, say briefly that you can only help with finding locations.'
].join('\n');

const AREAS = ['standard', 'bulk', 'linbin', 'jewellery', 'security', 'cash_collection'];
const TOOLS = [
  {
    name: 'lookup_location',
    description: 'Look up one location. Returns its read-out, check character, locations one headset mistake away that share the check character, and its physical neighbours with their check characters.',
    input_schema: { type: 'object', properties: { location: { type: 'string', description: 'Four-character location such as 40JH, Z41K, L10A, J5IM or CA12' } }, required: ['location'] }
  },
  {
    name: 'list_locations_with_check_char',
    description: 'List every location that uses a check character, in one area, optionally limited to an aisle range. Returns at most 120 locations.',
    input_schema: {
      type: 'object',
      properties: {
        checkChar: { type: 'string', description: 'NATO phonetic word, e.g. ECHO' },
        area: { type: 'string', enum: AREAS },
        fromAisle: { type: 'integer', minimum: 0, maximum: 99 },
        toAisle: { type: 'integer', minimum: 0, maximum: 99 }
      },
      required: ['checkChar', 'area']
    }
  }
];
const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

// Best-effort limit per visitor while a function instance stays warm.
const hits = new Map();
const LIMIT = 40, WINDOW_MS = 10 * 60 * 1000;
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  return list.length > LIMIT;
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});

function validMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 12) return false;
  if (messages[0].role !== 'user' || messages[messages.length - 1].role !== 'user') return false;
  if (JSON.stringify(messages).length > 80000) return false;
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return false;
    if (typeof m.content === 'string') { if (!m.content.trim() || m.content.length > 6000) return false; continue; }
    if (!Array.isArray(m.content) || !m.content.length || m.content.length > 10) return false;
    for (const b of m.content) {
      if (!b || typeof b !== 'object') return false;
      if (b.type === 'text') { if (typeof b.text !== 'string') return false; }
      else if (b.type === 'tool_use') { if (m.role !== 'assistant' || !TOOL_NAMES.has(b.name) || typeof b.id !== 'string') return false; }
      else if (b.type === 'tool_result') { if (m.role !== 'user' || typeof b.tool_use_id !== 'string' || typeof b.content !== 'string' || b.content.length > 20000) return false; }
      else return false;
    }
  }
  return true;
}

export default async (req, context) => {
  const key = process.env.ANTHROPIC_API_KEY;
  const code = process.env.ACCESS_CODE || '';

  if (req.method === 'GET') return json(200, { ok: true, configured: !!key, needsCode: !!code });
  if (req.method !== 'POST') return json(405, { code: 'invalid_request', error: 'Use POST' });
  if (!key) return json(500, { code: 'not_configured', error: 'ANTHROPIC_API_KEY is not set' });
  if (code && req.headers.get('x-access-code') !== code) return json(401, { code: 'bad_code', error: 'Wrong access code' });

  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  if (rateLimited(ip)) return json(429, { code: 'rate_limited', error: 'Too many requests, try again in a few minutes' });

  let body;
  try { body = await req.json(); } catch { return json(400, { code: 'invalid_request', error: 'Bad JSON' }); }
  const messages = body && body.messages;
  if (!validMessages(messages)) return json(400, { code: 'invalid_request', error: 'Bad messages' });

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.MODEL || 'claude-haiku-5-5', max_tokens: 700, system: SYSTEM, tools: TOOLS, messages })
    });
  } catch {
    return json(502, { code: 'upstream_error', error: 'Could not reach Anthropic' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const status = res.status === 429 ? 429 : 502;
    console.error('Anthropic error', res.status, data && data.error);
    return json(status, { code: res.status === 429 ? 'rate_limited' : 'upstream_error', error: (data.error && data.error.message) || 'Anthropic error' });
  }
  const content = (data.content || [])
    .filter(b => b.type === 'text' || b.type === 'tool_use')
    .map(b => b.type === 'text' ? { type: 'text', text: b.text } : { type: 'tool_use', id: b.id, name: b.name, input: b.input });
  return json(200, { content, stop_reason: data.stop_reason });
};

export const config = { path: '/api/ask' };
