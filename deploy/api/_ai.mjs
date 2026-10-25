// 04 AI 학습용 챗봇 — Vercel 함수 공통 부분 (파일 이름이 _로 시작해 주소로는 열리지 않음)
// API 키는 Vercel 환경 변수에만 두고 학생 브라우저로 보내지 않습니다.
//   AI_KEY (필수, Sensitive) · AI_PROVIDER (claude|openai|gemini) · AI_MODEL · AI_EFFORT (선택) · RATE_MAX (선택, 기본 60)

export const PROVIDERS = ['claude', 'openai', 'gemini'];
const isReasoningModel = m => /^(gpt-[5-9]|o\d)/.test(m);

export function aiEnv() {
  const e = process.env;
  const provider = String(e.AI_PROVIDER || '').trim().toLowerCase();
  return { provider, key: String(e.AI_KEY || '').trim(), model: String(e.AI_MODEL || '').trim(), effort: String(e.AI_EFFORT || '').trim(),
    ready: PROVIDERS.includes(provider) && !!String(e.AI_KEY || '').trim() && !!String(e.AI_MODEL || '').trim() };
}

export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

// 같은 IP는 10분에 RATE_MAX번까지 (함수 인스턴스마다 따로라 대략적인 제한)
const hits = new Map();
export function rateOK(ip) {
  const max = Number(process.env.RATE_MAX) || 60, win = 10 * 60 * 1000, now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < win);
  if (list.length >= max) { hits.set(ip, list); return false; }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return true;
}

export function providerRequest(a, system, hist, maxTokens, stream) {
  if (a.provider === 'claude') return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'x-api-key': a.key, 'anthropic-version': '2023-06-01' },
    body: { model: a.model, max_tokens: maxTokens, stream, system, messages: hist.map(m => ({ role: m.role, content: m.text })) }
  };
  if (a.provider === 'openai') {
    const body = { model: a.model, stream, messages: [{ role: isReasoningModel(a.model) ? 'developer' : 'system', content: system }, ...hist.map(m => ({ role: m.role, content: m.text }))] };
    if (a.effort && isReasoningModel(a.model)) body.reasoning_effort = a.effort;
    return { url: 'https://api.openai.com/v1/chat/completions', headers: { authorization: `Bearer ${a.key}` }, body };
  }
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(a.model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
    headers: { 'x-goog-api-key': a.key },
    body: { systemInstruction: { parts: [{ text: system }] }, contents: hist.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })) }
  };
}
