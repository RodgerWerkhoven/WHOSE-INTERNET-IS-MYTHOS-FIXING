const OPENAI_COMPAT_ENDPOINTS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions'
};

const ENV_KEY_BY_PROVIDER = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY'
};

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 40;
const MAX_BODY_BYTES = 128 * 1024;
const rateLimitStore = globalThis.__MYTHOS_RATE_LIMIT__ || (globalThis.__MYTHOS_RATE_LIMIT__ = new Map());

function sendJson(res, status, payload){
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sendText(res, status, message){
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(message);
}

function cleanupRateLimit(now){
  for(const [key, entry] of rateLimitStore){
    if(now - entry.startedAt > RATE_LIMIT_WINDOW_MS) rateLimitStore.delete(key);
  }
}

function getClientId(req){
  const forwarded = req.headers['x-forwarded-for'];
  if(typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(req){
  const now = Date.now();
  cleanupRateLimit(now);
  const clientId = getClientId(req);
  const current = rateLimitStore.get(clientId);
  if(!current || now - current.startedAt > RATE_LIMIT_WINDOW_MS){
    rateLimitStore.set(clientId, { count: 1, startedAt: now });
    return { ok: true };
  }
  if(current.count >= RATE_LIMIT_MAX){
    return { ok: false, retryAfterSec: Math.ceil((RATE_LIMIT_WINDOW_MS - (now - current.startedAt)) / 1000) };
  }
  current.count += 1;
  return { ok: true };
}

async function readJsonBody(req){
  if(req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  let total = 0;
  for await (const chunk of req){
    total += chunk.length;
    if(total > MAX_BODY_BYTES) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function listOwnerKeyProviders(){
  return Object.entries(ENV_KEY_BY_PROVIDER)
    .filter(([, envName]) => process.env[envName])
    .map(([provider]) => provider);
}

function resolveApiKey(provider, userSuppliedKey){
  const sessionKey = typeof userSuppliedKey === 'string' ? userSuppliedKey.trim() : '';
  if(sessionKey) return sessionKey;
  const envName = ENV_KEY_BY_PROVIDER[provider];
  return envName ? (process.env[envName] || '').trim() : '';
}

function validatePayload(body){
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';

  if(!provider || !['openai', 'anthropic', 'groq', 'openrouter'].includes(provider)){
    throw new Error('Unsupported provider for the secure proxy.');
  }
  if(!model) throw new Error('Missing model.');
  if(!prompt) throw new Error('Missing prompt.');
  if(prompt.length > 40000) throw new Error('Prompt is too large.');

  return { provider, model, prompt, apiKey: typeof body.apiKey === 'string' ? body.apiKey : '' };
}

async function pumpReadableToText(response, onChunk){
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while(true){
    const { value, done } = await reader.read();
    if(done) break;
    const chunk = decoder.decode(value, { stream: true });
    if(chunk) onChunk(chunk);
  }
}

async function relayOpenAICompat(response, res){
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while(true){
    const { value, done } = await reader.read();
    if(done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for(const line of lines){
      const trimmed = line.trim();
      if(!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if(data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const content = json.choices?.[0]?.delta?.content;
        if(typeof content === 'string' && content) res.write(content);
      } catch(_) {}
    }
  }
}

async function relayAnthropic(response, res){
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while(true){
    const { value, done } = await reader.read();
    if(done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for(const line of lines){
      const trimmed = line.trim();
      if(!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      try {
        const json = JSON.parse(data);
        if(json.type === 'content_block_delta' && json.delta?.type === 'text_delta' && json.delta.text){
          res.write(json.delta.text);
        }
      } catch(_) {}
    }
  }
}

async function relayProvider({ provider, model, prompt, apiKey, req, res }){
  if(provider === 'anthropic'){
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        stream: true,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if(!upstream.ok){
      const text = await upstream.text();
      sendText(res, upstream.status, text.slice(0, 800) || 'Anthropic proxy request failed.');
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    await relayAnthropic(upstream, res);
    res.end();
    return;
  }

  const endpoint = OPENAI_COMPAT_ENDPOINTS[provider];
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };

  if(provider === 'openrouter'){
    const origin = typeof req.headers.origin === 'string' && req.headers.origin ? req.headers.origin : `https://${req.headers.host}`;
    headers['HTTP-Referer'] = origin;
    headers['X-Title'] = 'WHOSE INTERNET IS MYTHOS FIXING?';
  }

  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      temperature: 0.2
    })
  });

  if(!upstream.ok){
    const text = await upstream.text();
    sendText(res, upstream.status, text.slice(0, 800) || 'Secure proxy request failed.');
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  await relayOpenAICompat(upstream, res);
  res.end();
}

module.exports = async (req, res) => {
  if(req.method === 'GET'){
    sendJson(res, 200, {
      ok: true,
      secureProxy: true,
      providers: Object.keys(ENV_KEY_BY_PROVIDER),
      ownerKeys: listOwnerKeyProviders(),
      note: 'Secure proxy is online. Browser-stored API keys are disabled on this host.'
    });
    return;
  }

  if(req.method !== 'POST'){
    sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
    return;
  }

  const limit = checkRateLimit(req);
  if(!limit.ok){
    res.setHeader('Retry-After', String(limit.retryAfterSec));
    sendText(res, 429, `Rate limit reached. Try again in about ${limit.retryAfterSec} seconds.`);
    return;
  }

  let body;
  try {
    body = validatePayload(await readJsonBody(req));
  } catch(err){
    sendText(res, 400, err.message || 'Invalid request body.');
    return;
  }

  const apiKey = resolveApiKey(body.provider, body.apiKey);
  if(!apiKey){
    sendText(
      res,
      400,
      'No secure API key is available for this provider yet. Enter your own key for this tab, or configure the matching server environment variable.'
    );
    return;
  }

  try {
    await relayProvider({ ...body, apiKey, req, res });
  } catch(err){
    sendText(res, 500, err.message || 'Secure proxy failed.');
  }
};
