const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 25;
const MAX_BODY_BYTES = 32 * 1024;
const SEARCH_RESULT_FETCH_LIMIT = 6;
const SEARCH_RESULT_RETURN_LIMIT = 4;
const MIN_RELEVANCE_SCORE = 8;
const QUESTION_STOP_WORDS = new Set([
  'about', 'after', 'again', 'all', 'also', 'and', 'any', 'are', 'because', 'been', 'before',
  'being', 'between', 'both', 'but', 'can', 'could', 'does', 'from', 'generally', 'have',
  'into', 'just', 'more', 'most', 'much', 'only', 'really', 'that', 'their', 'them', 'then',
  'there', 'these', 'the', 'they', 'this', 'those', 'through', 'under', 'used', 'uses', 'using',
  'very', 'want', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'with', 'would',
  'your'
]);
const TRUSTED_MEDIA_DOMAINS = new Set([
  'techcrunch.com',
  'thehackernews.com',
  'cnbc.com',
  'reuters.com',
  'forbes.com',
  'scworld.com',
  'infosecurity-magazine.com',
  'gadgets360.com',
  'understandingai.org',
  'simonwillison.net'
]);
const TRUSTED_CREATOR_DOMAINS = new Set([
  'anotherdimension.rocks',
  'github.io',
  'github.com',
  'linkedin.com',
  'nl.linkedin.com',
  'ai-expo.net',
  'creativeindmena.com',
  'ai.weekend.hr',
  'martechview.com',
  'deadendgallery.com',
  'bedigitaluk.com'
]);
const RATE_LIMIT_STORE = globalThis.__MYTHOS_QA_CONTEXT_RATE_LIMIT__ || (globalThis.__MYTHOS_QA_CONTEXT_RATE_LIMIT__ = new Map());

function sendJson(res, status, payload){
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function cleanupRateLimit(now){
  for(const [key, entry] of RATE_LIMIT_STORE){
    if(now - entry.startedAt > RATE_LIMIT_WINDOW_MS) RATE_LIMIT_STORE.delete(key);
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
  const current = RATE_LIMIT_STORE.get(clientId);
  if(!current || now - current.startedAt > RATE_LIMIT_WINDOW_MS){
    RATE_LIMIT_STORE.set(clientId, { count: 1, startedAt: now });
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

function stripTags(value = ''){
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#92;/gi, '\\')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value = ''){
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#92;/g, '\\')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function tokenizeQuestion(question){
  const terms = question.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  return [...new Set(terms.filter((term) => !QUESTION_STOP_WORDS.has(term)))];
}

function isMythosScopedQuestion(question){
  return /\b(anthropic|mythos|glasswing|claude)\b/i.test(question);
}

function isCreatorScopedQuestion(question){
  return /\b(rodger werkhoven|rodger|werkhoven|anotherdimension|anótherdimension)\b/i.test(question)
    || (
      /\b(maker|creator|author|built|build|made|created)\b/i.test(question)
      && /\b(tool|site|page|project|app|map|explainer|experience)\b/i.test(question)
    );
}

function detectQuestionScope(question){
  return {
    mythos: isMythosScopedQuestion(question),
    creator: isCreatorScopedQuestion(question)
  };
}

function buildSearchQueries(question){
  const cleanQuestion = question.replace(/\s+/g, ' ').trim();
  const scope = detectQuestionScope(cleanQuestion);

  if(scope.creator && !scope.mythos){
    return [
      `${cleanQuestion} "Rodger Werkhoven" AI`,
      `${cleanQuestion} "Rodger Werkhoven"`,
      `"Rodger Werkhoven" AI`,
      `"Rodger Werkhoven" "anotherdimension.rocks"`,
      `"WHOSE INTERNET IS MYTHOS FIXING" "Rodger Werkhoven"`
    ];
  }

  const queries = [
    `${cleanQuestion} "Claude Mythos Preview" Anthropic`,
    `${cleanQuestion} "Project Glasswing" Anthropic`,
    `${cleanQuestion} Anthropic Mythos`
  ];

  if(/\b(author|authored|blog|post|technical|red team|research|wrote|write)\b/i.test(cleanQuestion)){
    queries.unshift(`${cleanQuestion} site:red.anthropic.com Anthropic Mythos`);
  }

  if(!/\bmythos\b/i.test(cleanQuestion)){
    queries.push(`${cleanQuestion} Anthropic "Claude Mythos Preview"`);
  }

  return [...new Set(queries)];
}

function decodeDuckDuckGoLink(rawHref = ''){
  const cleaned = decodeHtmlEntities(rawHref).trim();
  if(!cleaned) return '';
  const absolute = cleaned.startsWith('//') ? `https:${cleaned}` : cleaned;
  try {
    const url = new URL(absolute);
    const redirected = url.searchParams.get('uddg');
    return redirected ? decodeURIComponent(redirected) : absolute;
  } catch(_) {
    return absolute;
  }
}

function normalizeLink(link = ''){
  try {
    const url = new URL(link);
    url.hash = '';
    if(url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
    return url.toString();
  } catch(_) {
    return link.trim();
  }
}

function getHostname(link = ''){
  try {
    return new URL(link).hostname.replace(/^www\./i, '').toLowerCase();
  } catch(_) {
    return '';
  }
}

function parseDuckDuckGoResults(html){
  const results = [];
  const seen = new Set();
  const anchorRegex = /<a\b[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while((match = anchorRegex.exec(html)) && results.length < 12){
    const link = normalizeLink(decodeDuckDuckGoLink(match[1]));
    if(!/^https?:\/\//i.test(link) || seen.has(link)) continue;

    const title = stripTags(decodeHtmlEntities(match[2]));
    const nearbyHtml = html.slice(match.index, Math.min(match.index + 2400, html.length));
    const snippet = stripTags(
      decodeHtmlEntities(
        nearbyHtml.match(/(?:<a class="result__snippet"[^>]*>|<div class="result__snippet">)([\s\S]*?)(?:<\/a>|<\/div>)/i)?.[1] || ''
      )
    );

    seen.add(link);
    results.push({
      title,
      link,
      description: snippet
    });
  }

  return results;
}

async function fetchText(url){
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; MythosSourceFallback/1.0; +https://whose-internet-is-mythos-fixing-sec.vercel.app)'
    }
  });
  if(!res.ok) throw new Error(`Fetch failed (${res.status})`);
  return {
    text: await res.text(),
    contentType: (res.headers.get('content-type') || '').toLowerCase()
  };
}

function extractMetaDescription(html){
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i
  ];
  for(const pattern of patterns){
    const match = html.match(pattern);
    if(match?.[1]) return decodeHtmlEntities(match[1].trim());
  }
  return '';
}

function extractTitle(html){
  const match = html.match(/<title>([\s\S]*?)<\/title>/i);
  return match?.[1] ? decodeHtmlEntities(stripTags(match[1])) : '';
}

function extractExcerpt(html){
  const paragraphs = [];
  const paragraphRegex = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while((match = paragraphRegex.exec(html)) && paragraphs.length < 4){
    const text = stripTags(match[1]);
    if(text && text.length > 80) paragraphs.push(text);
  }
  const meta = extractMetaDescription(html);
  const body = paragraphs.join(' ').trim();
  return [meta, body].filter(Boolean).join(' ').slice(0, 1400).trim();
}

function measureResultRelevance(result, questionTerms, scope){
  const hostname = getHostname(result.link);
  const combined = `${result.title} ${result.description || ''} ${result.excerpt || ''} ${result.link}`.toLowerCase();
  let score = 0;

  if(scope.mythos){
    if(hostname.endsWith('anthropic.com')) score += hostname === 'red.anthropic.com' ? 10 : 9;
    else if(TRUSTED_MEDIA_DOMAINS.has(hostname)) score += 4;

    if(combined.includes('claude mythos preview')) score += 8;
    if(combined.includes('project glasswing')) score += 7;
    if(combined.includes('mythos')) score += 6;
    if(combined.includes('glasswing')) score += 5;
    if(combined.includes('anthropic')) score += 4;
    if(combined.includes('preview')) score += 1;
  }

  if(scope.creator){
    if(
      hostname === 'anotherdimension.rocks'
      || hostname === 'rodgerwerkhoven.github.io'
      || hostname === 'github.com'
      || hostname === 'linkedin.com'
      || hostname === 'nl.linkedin.com'
    ) score += 8;
    else if(TRUSTED_CREATOR_DOMAINS.has(hostname)) score += 5;

    if(combined.includes('rodger werkhoven')) score += 12;
    else if(combined.includes('rodger') && combined.includes('werkhoven')) score += 8;
    if(combined.includes('anotherdimension')) score += 8;
    if(combined.includes('whose internet is mythos fixing')) score += 6;
    if(combined.includes('artificial intelligence') || combined.includes(' field of ai ') || combined.includes(' ai ') || combined.includes('openai')) score += 3;
  }

  let termHits = 0;
  for(const term of questionTerms){
    if(combined.includes(term)){
      termHits += 1;
      score += 1;
    }
  }

  if(termHits === 0) score -= 5;
  if(scope.mythos && !combined.includes('anthropic') && !combined.includes('mythos') && !combined.includes('glasswing')) score -= 10;
  if(scope.creator && !combined.includes('rodger') && !combined.includes('werkhoven') && !combined.includes('anotherdimension')) score -= 12;

  return { score, termHits };
}

async function fetchResultContext(result){
  try {
    const page = await fetchText(result.link);
    if(!page.contentType.includes('html') && !page.contentType.includes('text/')) {
      return {
        ...result,
        excerpt: (result.description || '').slice(0, 900)
      };
    }

    const title = extractTitle(page.text) || result.title;
    const excerpt = extractExcerpt(page.text) || result.description;
    return {
      ...result,
      title,
      excerpt: excerpt.slice(0, 1400)
    };
  } catch(_) {
    return {
      ...result,
      excerpt: (result.description || '').slice(0, 900)
    };
  }
}

async function searchDuckDuckGo(query){
  const searchUrl = `https://html.duckduckgo.com/html/?kl=us-en&q=${encodeURIComponent(query)}`;
  const response = await fetchText(searchUrl);
  return parseDuckDuckGoResults(response.text);
}

async function searchInternet(question){
  const queries = buildSearchQueries(question);
  const questionTerms = tokenizeQuestion(question);
  const scope = detectQuestionScope(question);
  const candidateMap = new Map();

  for(const query of queries){
    const results = await searchDuckDuckGo(query);
    for(const item of results){
      const key = normalizeLink(item.link);
      if(!key || candidateMap.has(key)) continue;

      const baseRelevance = measureResultRelevance(item, questionTerms, scope);
      if(baseRelevance.score < 3) continue;

      candidateMap.set(key, {
        ...item,
        searchQuery: query,
        baseScore: baseRelevance.score,
        baseTermHits: baseRelevance.termHits
      });
    }
  }

  const toFetch = [...candidateMap.values()]
    .sort((a, b) => b.baseScore - a.baseScore)
    .slice(0, SEARCH_RESULT_FETCH_LIMIT);

  const enriched = await Promise.all(toFetch.map(fetchResultContext));
  const scored = enriched
    .map((item) => ({
      ...item,
      ...measureResultRelevance(item, questionTerms, scope)
    }))
    .filter((item) => item.score >= MIN_RELEVANCE_SCORE)
    .filter((item) => (scope.mythos || scope.creator) ? item.termHits > 0 || item.score >= MIN_RELEVANCE_SCORE + 4 : item.termHits > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SEARCH_RESULT_RETURN_LIMIT);

  return {
    query: queries.join(' || '),
    results: scored.map((item, index) => ({
      id: `Internet ${index + 1}`,
      title: item.title,
      url: item.link,
      snippet: (item.description || '').slice(0, 380),
      excerpt: item.excerpt || '',
      sourceQuery: item.searchQuery || '',
      pubDate: ''
    }))
  };
}

module.exports = async (req, res) => {
  if(req.method !== 'POST'){
    sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
    return;
  }

  const limit = checkRateLimit(req);
  if(!limit.ok){
    res.setHeader('Retry-After', String(limit.retryAfterSec));
    sendJson(res, 429, { ok: false, error: `Rate limit reached. Try again in about ${limit.retryAfterSec} seconds.` });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch(err){
    sendJson(res, 400, { ok: false, error: err.message || 'Invalid request body.' });
    return;
  }

  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if(!question){
    sendJson(res, 400, { ok: false, error: 'Missing question.' });
    return;
  }
  if(question.length > 500){
    sendJson(res, 400, { ok: false, error: 'Question too long.' });
    return;
  }

  try {
    const packet = await searchInternet(question);
    sendJson(res, 200, {
      ok: true,
      mode: 'internet-fallback-packet',
      note: 'Use the official Anthropic sources first. Only use these web results if those sources do not answer the question, and then say explicitly that the answer comes from internet search results.',
      ...packet
    });
  } catch(err){
    sendJson(res, 200, {
      ok: true,
      mode: 'internet-fallback-packet',
      note: 'Internet fallback search was unavailable for this request.',
      query: question,
      results: [],
      searchError: err.message || 'Internet search failed.'
    });
  }
};
