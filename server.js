// StudyBuddy server: zero dependencies, Node 18+. Keys stay here, never in the browser.
const http = require('http'), fs = require('fs'), path = require('path'), { Readable } = require('stream');

try { // minimal .env loader
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
const E = process.env, PORT = E.PORT || 3000;

const PROVIDERS = {
  openrouter: { name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', key: E.OPENROUTER_API_KEY,
    headers: { 'HTTP-Referer': E.APP_URL || 'http://localhost:' + PORT, 'X-Title': 'StudyBuddy' },
    fallback: ['openai/gpt-4o-mini', 'google/gemini-2.0-flash-001', 'anthropic/claude-3.5-sonnet', 'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-chat-v3-0324:free'] },
  nvidia: { name: 'NVIDIA', base: 'https://integrate.api.nvidia.com/v1', key: E.NVIDIA_API_KEY,
    fallback: ['meta/llama-3.3-70b-instruct', 'nvidia/llama-3.1-nemotron-70b-instruct', 'deepseek-ai/deepseek-r1', 'mistralai/mistral-large-2-instruct'] },
  gemini: { name: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: E.GEMINI_API_KEY,
    fallback: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'] },
};
const authHeaders = p => ({ Authorization: 'Bearer ' + p.key, ...(p.name === 'Gemini' ? { 'x-goog-api-key': p.key } : {}), ...(p.headers || {}) });

const hits = new Map(); // tiny rate limiter
function limited(req, bucket, max) {
  const k = bucket + (req.headers['x-forwarded-for'] || req.socket.remoteAddress), now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < 60000); arr.push(now); hits.set(k, arr);
  return arr.length > max;
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, no) => {
  let n = 0; const c = [];
  req.on('data', d => { n += d.length; if (n > 30e6) { no(new Error('Request too large (30 MB max)')); req.destroy(); } else c.push(d); });
  req.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch { no(new Error('Bad JSON')); } });
  req.on('error', no);
});

const modelCache = {};
async function listModels(id) {
  const p = PROVIDERS[id];
  if (!p.key) return [];
  const c = modelCache[id]; if (c && Date.now() - c.t < 3600e3) return c.v;
  let v = p.fallback;
  try {
    const r = await fetch(p.base + '/models', { headers: authHeaders(p), signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const d = await r.json(), items = d.data || d.models || [];
      const clean = x => String(x.id || x.name).replace(/^models\//, '');
      let ids = items.map(clean);
      if (id === 'gemini') { // newest first, flash before pro
        const ver = x => parseFloat((x.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1]) || 0;
        ids = ids.filter(x => /^gemini/.test(x) && !/embed|aqa|imagen|tts|vision|image|live|audio/.test(x))
          .sort((a, b) => ver(b) - ver(a) || (/flash/.test(b) - /flash/.test(a)) || (/lite/.test(a) - /lite/.test(b)) || a.localeCompare(b));
        if (ids.length) v = ids;
      } else if (id === 'openrouter') { // free models first so it works with no credits
        const bad = /embed|image|audio|moderation/;
        const free = items.filter(m => /:free$/.test(m.id) || (m.pricing && +m.pricing.prompt === 0 && +m.pricing.completion === 0)).map(clean).filter(x => !bad.test(x)).sort();
        const paid = ids.filter(x => /^(openai|anthropic|google|meta-llama|deepseek|mistralai|qwen|x-ai)\//.test(x) && !bad.test(x) && !free.includes(x)).slice(0, 100);
        if (free.length || paid.length) v = [...free.slice(0, 60), ...paid];
      } else {
        ids = ids.filter(x => !/embed|rerank|guard|reward|parse|clip/.test(x));
        if (ids.length) v = [...new Set([...p.fallback.filter(x => ids.includes(x)), ...ids.sort()])];
      }
    }
  } catch {}
  modelCache[id] = { t: Date.now(), v };
  return v;
}

const VOICES = [['21m00Tcm4TlvDq8ikWAM', 'Rachel'], ['pNInz6obpgDQGcFmaJgB', 'Adam'], ['EXAVITQu4vr4xnSDxMbR', 'Bella'], ['ErXwobaYiN019PkySvjV', 'Antoni'], ['TxGEqnHWrfWFTfGW9XjX', 'Josh'], ['MF3mGyEYCl7XYWbV9V6O', 'Elli']]
  .map(([id, name]) => ({ id, name }));

async function api(req, res, url) {
  if (url === '/api/config') return json(res, 200, { providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, { name: p.name, ok: !!p.key }])), voice: !!E.ELEVENLABS_API_KEY });
  if (url === '/api/models') {
    const out = {}; await Promise.all(Object.keys(PROVIDERS).map(async k => { out[k] = await listModels(k); }));
    return json(res, 200, out);
  }
  if (url === '/api/voices') {
    let voices = VOICES;
    try {
      const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': E.ELEVENLABS_API_KEY }, signal: AbortSignal.timeout(8000) });
      if (r.ok) { const d = await r.json(); if (d.voices?.length) voices = d.voices.map(v => ({ id: v.voice_id, name: v.name })); }
    } catch {}
    return json(res, 200, voices);
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  if (url === '/api/chat') {
    if (limited(req, 'chat', 40)) return json(res, 429, { error: 'Slow down: too many messages this minute.' });
    const b = await readBody(req), p = PROVIDERS[b.provider];
    if (!p) return json(res, 400, { error: 'Unknown provider' });
    if (!p.key) return json(res, 400, { error: p.name + ' key is not set on the server.' });
    if (!b.model || !Array.isArray(b.messages)) return json(res, 400, { error: 'Missing model or messages' });
    const ctl = new AbortController(); res.on('close', () => ctl.abort());
    const up = await fetch(p.base + '/chat/completions', {
      method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', ...authHeaders(p) },
      body: JSON.stringify({ model: b.model, messages: b.messages, stream: true, max_tokens: 4096 }),
    });
    if (!up.ok) {
      let t = await up.text(), msg = t; try { const j = JSON.parse(t); msg = j.error?.message || j.message || j.detail || (Array.isArray(j) ? j[0]?.error?.message : '') || t; } catch {}
      return json(res, up.status, { error: `${p.name} error ${up.status}: ${String(msg).slice(0, 300)}` });
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    Readable.fromWeb(up.body).on('error', () => res.end()).pipe(res);
    return;
  }

  if (url === '/api/tts') {
    if (!E.ELEVENLABS_API_KEY) return json(res, 400, { error: 'ElevenLabs key is not set on the server.' });
    if (limited(req, 'tts', 20)) return json(res, 429, { error: 'Too many voice requests this minute.' });
    const b = await readBody(req), text = String(b.text || '').slice(0, 4000).trim();
    if (!text) return json(res, 400, { error: 'Nothing to read' });
    const voice = encodeURIComponent(b.voiceId || VOICES[0].id);
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': E.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: E.ELEVEN_MODEL || 'eleven_flash_v2_5' }),
    });
    if (!r.ok) { let m = await r.text(); try { const j = JSON.parse(m); m = j.detail?.message || j.detail || m; } catch {} return json(res, r.status, { error: 'ElevenLabs: ' + String(m).slice(0, 250) }); }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  json(res, 404, { error: 'Not found' });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url.startsWith('/api/')) return await api(req, res, url);
    const f = path.join(__dirname, 'public', url === '/' ? 'index.html' : path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
    if (!f.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.name === 'AbortError' ? 'Cancelled' : e.message || 'Server error' }); else res.end();
  }
}).listen(PORT, () => console.log('StudyBuddy running on http://localhost:' + PORT));
