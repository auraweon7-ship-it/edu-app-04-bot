// POST /api/chat → 학생 질문을 교수 키(환경 변수)로 AI에 보내고 답을 스트리밍으로 돌려줌
import { aiEnv, json, rateOK, providerRequest } from './_ai.mjs';

export async function POST(request) {
  const a = aiEnv();
  if (!a.ready) return json(503, { error: { message: '배포 서버에 AI 키·제공자·모델이 설정되지 않았습니다 (Vercel 환경 변수)' } });
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  if (!rateOK(ip)) return json(429, { error: { message: '질문이 너무 많습니다. 잠시 뒤 다시 시도하세요' } });
  const text = await request.text();
  if (text.length > 2 * 1024 * 1024) return json(413, { error: { message: '요청이 너무 큽니다' } });
  let d;
  try { d = JSON.parse(text); } catch { return json(400, { error: { message: '요청 형식이 맞지 않습니다' } }); }
  if (typeof d.system !== 'string' || !Array.isArray(d.history) || !d.history.every(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')) {
    return json(400, { error: { message: '요청 형식이 맞지 않습니다' } });
  }
  const maxTokens = Math.min(Math.max(Number(d.maxTokens) || 2048, 100), 4096);
  const hist = d.history.slice(-14);
  try {
    const p = providerRequest(a, d.system, hist, maxTokens, true);
    const r = await fetch(p.url, { method: 'POST', headers: { 'content-type': 'application/json', ...p.headers }, body: JSON.stringify(p.body), signal: request.signal });
    if (!r.ok) {
      const errText = await r.text();
      // OpenAI 상위 모델: 조직 인증 전에는 스트리밍이 막힐 수 있음 → 한 번에 받아 같은 형식으로 보냄
      if (a.provider === 'openai' && /stream/i.test(errText) && /verif|organization/i.test(errText)) {
        const p2 = providerRequest(a, d.system, hist, maxTokens, false);
        const r2 = await fetch(p2.url, { method: 'POST', headers: { 'content-type': 'application/json', ...p2.headers }, body: JSON.stringify(p2.body) });
        const b2 = await r2.json().catch(() => ({}));
        if (!r2.ok) return json(r2.status, { error: { message: b2?.error?.message || `HTTP ${r2.status}` } });
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: b2.choices?.[0]?.message?.content || '' } }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } });
      }
      let msg = `HTTP ${r.status}`;
      try { const b = JSON.parse(errText); msg = b?.error?.message || (Array.isArray(b) && b[0]?.error?.message) || msg; } catch {}
      return json(r.status, { error: { message: `AI 제공자 오류 — ${msg}` } });
    }
    return new Response(r.body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } });
  } catch (e) {
    return json(502, { error: { message: `AI 서버에 연결할 수 없습니다 — ${e.message}` } });
  }
}
