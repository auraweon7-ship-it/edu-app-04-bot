// 04 AI 학습용 챗봇 — 같은 네트워크(공유기)용 작은 서버
// - 앱 파일(index.html 등)을 그대로 보여 줌
// - GET  /api/deploy : 교수 모드에서 게시한 참고자료 세트(학생 화면이 불러감)
// - PUT  /api/deploy : 교수 모드에서 게시 (교수 로그인 토큰 필요)
// - /api/ai          : 학생 화면에서 쓸 교수 API 키 설정 (GET은 사용 여부만, PUT·DELETE는 교수 토큰 필요)
// - POST /api/chat   : 학생 질문을 교수 키로 AI에 보내고 답을 스트리밍으로 돌려줌 (키는 학생에게 보내지 않음)
// 실행: node server.js  →  http://<이 PC의 IP>:8765
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8765;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
// 과목 코드(?c=)마다 게시 파일을 따로 둠: data/deploy.json, data/deploy-과목코드.json
const deployFile = req => {
  const c = (new URL(req.url, 'http://localhost').searchParams.get('c') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  return path.join(DATA_DIR, c ? `deploy-${c}.json` : 'deploy.json');
};
const MAX_BODY = 30 * 1024 * 1024;
// 교수 로그인 토큰의 SHA-256 값 (비밀번호 원문은 두지 않음)
const TOKEN_HASH = '19e34df315e4651ab2ffc9a4a0e2077779b3034261063e37e2834e657721991e';
// 내려받기 금지: 서버 코드·원본·게시 데이터 폴더
const BLOCKED = new Set(['server.js', 'build.js', 'src', 'data', 'worker', 'vercel', '.claude', 'node_modules']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function validDeploy(d) {
  return d && typeof d === 'object' && Array.isArray(d.materials) && d.materials.length <= 200 &&
    d.materials.every(m => m && typeof m.name === 'string' && typeof m.text === 'string');
}

async function api(req, res) {
  const DEPLOY_FILE = deployFile(req);
  if (req.method === 'GET') {
    fs.readFile(DEPLOY_FILE, (err, buf) => err ? send(res, 404, { error: '게시된 참고자료가 없습니다' }) : send(res, 200, buf));
    return;
  }
  if (req.method !== 'PUT') return send(res, 405, { error: 'GET 또는 PUT만 쓸 수 있습니다' });
  const token = String(req.headers['x-tutorbot-token'] || '');
  if (!token || sha256(token) !== TOKEN_HASH) return send(res, 401, { error: '교수 로그인이 필요합니다' });
  let size = 0;
  const chunks = [];
  req.on('data', c => {
    size += c.length;
    if (size > MAX_BODY) { send(res, 413, { error: '자료가 너무 큽니다(30MB 초과)' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let d;
    try { d = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'JSON 형식이 아닙니다' }); }
    if (!validDeploy(d)) return send(res, 400, { error: '참고자료 세트 형식이 맞지 않습니다' });
    d.updatedAt = new Date().toISOString();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DEPLOY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d));
    fs.renameSync(tmp, DEPLOY_FILE);
    console.log(`[${new Date().toLocaleString('ko-KR')}] 학생 화면에 게시: ${d.course?.course || d.title || '-'} · 자료 ${d.materials.length}개`);
    send(res, 200, { ok: true, updatedAt: d.updatedAt, materials: d.materials.length });
  });
}

// ---------- 교수 API 키로 학생 질문 대신 보내기 (키는 서버에만 두고 학생 브라우저로 보내지 않음) ----------
const AI_FILE = path.join(DATA_DIR, 'ai.json');
const PROVIDERS = ['claude', 'openai', 'gemini'];
const readAI = () => { try { return JSON.parse(fs.readFileSync(AI_FILE, 'utf8')); } catch { return null; } };
const isReasoningModel = m => /^(gpt-[5-9]|o\d)/.test(m);
// 같은 기기(IP)에서 10분에 60번까지만 (키 남용 방지)
const RATE = { windowMs: 10 * 60 * 1000, max: 60 }, hits = new Map();
function rateOK(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < RATE.windowMs);
  if (list.length >= RATE.max) { hits.set(ip, list); return false; }
  list.push(now); hits.set(ip, list);
  return true;
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function authOK(req) { const t = String(req.headers['x-tutorbot-token'] || ''); return t && sha256(t) === TOKEN_HASH; }

async function aiConfig(req, res) {
  if (req.method === 'GET') { const a = readAI(); return send(res, 200, a ? { enabled: true, provider: a.provider, model: a.model } : { enabled: false }); }
  if (!authOK(req)) return send(res, 401, { error: '교수 로그인이 필요합니다' });
  if (req.method === 'DELETE') { try { fs.unlinkSync(AI_FILE); } catch {} console.log(`[${new Date().toLocaleString('ko-KR')}] 학생 화면 AI 끔`); return send(res, 200, { ok: true, enabled: false }); }
  if (req.method !== 'PUT') return send(res, 405, { error: 'GET·PUT·DELETE만 쓸 수 있습니다' });
  let d;
  try { d = JSON.parse(await readBody(req, 64 * 1024)); } catch { return send(res, 400, { error: 'JSON 형식이 아닙니다' }); }
  if (!PROVIDERS.includes(d.provider) || typeof d.key !== 'string' || !d.key.trim() || typeof d.model !== 'string' || !d.model.trim()) return send(res, 400, { error: '제공자·키·모델을 확인하세요' });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(AI_FILE, JSON.stringify({ provider: d.provider, key: d.key.trim(), model: d.model.trim(), effort: typeof d.effort === 'string' ? d.effort : '' }));
  console.log(`[${new Date().toLocaleString('ko-KR')}] 학생 화면 AI 켬: ${d.provider} · ${d.model}`);
  send(res, 200, { ok: true, enabled: true, provider: d.provider, model: d.model.trim() });
}

// ---------- 교과목 목록 (교수가 등록, 학생 화면이 읽음) ----------
const COURSES_FILE = path.join(DATA_DIR, 'courses.json');
async function coursesApi(req, res) {
  if (req.method === 'GET') {
    fs.readFile(COURSES_FILE, (err, buf) => err ? send(res, 404, { error: '등록된 교과목이 없습니다' }) : send(res, 200, buf));
    return;
  }
  if (req.method !== 'PUT') return send(res, 405, { error: 'GET 또는 PUT만 쓸 수 있습니다' });
  if (!authOK(req)) return send(res, 401, { error: '교수 로그인이 필요합니다' });
  let d;
  try { d = JSON.parse(await readBody(req, 256 * 1024)); } catch { return send(res, 400, { error: 'JSON 형식이 아닙니다' }); }
  const list = Array.isArray(d?.courses) ? d.courses.filter(c => c && typeof c.code === 'string' && typeof c.name === 'string').slice(0, 200)
    .map(c => ({ code: c.code.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32), name: c.name.trim().slice(0, 60) })).filter(c => c.code && c.name) : null;
  if (!list) return send(res, 400, { error: '교과목 목록 형식이 맞지 않습니다' });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(COURSES_FILE, JSON.stringify({ courses: list, updatedAt: new Date().toISOString() }));
  console.log(`[${new Date().toLocaleString('ko-KR')}] 교과목 목록 게시: ${list.map(c => c.name).join(', ') || '(없음)'}`);
  send(res, 200, { ok: true, courses: list.length });
}

function providerRequest(a, system, hist, maxTokens, stream) {
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

async function chat(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST만 쓸 수 있습니다' });
  const a = readAI();
  if (!a) return send(res, 503, { error: { message: '교수님이 학생 화면 AI를 켜지 않았습니다' } });
  const ip = req.socket.remoteAddress || '';
  if (!rateOK(ip)) return send(res, 429, { error: { message: '질문이 너무 많습니다. 잠시 뒤 다시 시도하세요 (10분에 60번까지)' } });
  let d;
  try { d = JSON.parse(await readBody(req, 2 * 1024 * 1024)); } catch { return send(res, 400, { error: { message: '요청 형식이 맞지 않습니다' } }); }
  if (typeof d.system !== 'string' || !Array.isArray(d.history) || !d.history.every(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')) {
    return send(res, 400, { error: { message: '요청 형식이 맞지 않습니다' } });
  }
  const maxTokens = Math.min(Math.max(Number(d.maxTokens) || 2048, 100), 4096);
  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  const p = providerRequest(a, d.system, d.history.slice(-14), maxTokens, true);
  try {
    const r = await fetch(p.url, { method: 'POST', headers: { 'content-type': 'application/json', ...p.headers }, body: JSON.stringify(p.body), signal: ctrl.signal });
    if (!r.ok) {
      const errText = await r.text();
      // OpenAI 상위 모델: 조직 인증 전에는 스트리밍이 막힐 수 있음 → 한 번에 받아 같은 형식으로 보냄
      if (a.provider === 'openai' && /stream/i.test(errText) && /verif|organization/i.test(errText)) {
        const p2 = providerRequest(a, d.system, d.history.slice(-14), maxTokens, false);
        const r2 = await fetch(p2.url, { method: 'POST', headers: { 'content-type': 'application/json', ...p2.headers }, body: JSON.stringify(p2.body), signal: ctrl.signal });
        const b2 = await r2.json().catch(() => ({}));
        if (!r2.ok) return send(res, r2.status, { error: { message: b2?.error?.message || `HTTP ${r2.status}` } });
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: b2.choices?.[0]?.message?.content || '' } }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      let msg = `HTTP ${r.status}`;
      try { const b = JSON.parse(errText); msg = b?.error?.message || (Array.isArray(b) && b[0]?.error?.message) || msg; } catch {}
      return send(res, r.status, { error: { message: `AI 제공자 오류 — ${msg}` } });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
    for await (const chunk of r.body) res.write(chunk);
    res.end();
  } catch (e) {
    if (ctrl.signal.aborted) return;
    if (!res.headersSent) send(res, 502, { error: { message: `AI 서버에 연결할 수 없습니다 — ${e.message}` } });
    else res.end();
  }
}

function serveFile(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  if (BLOCKED.has(rel.split('/')[0])) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer((req, res) => {
  let { pathname } = new URL(req.url, 'http://localhost');
  // 페이지 주소 뒤에 경로가 붙어 있어도(예: /index.html/api/deploy) API로 처리
  const apiMatch = pathname.match(/\/api\/(deploy|ai|chat|courses)\/?$/);
  if (apiMatch) pathname = `/api/${apiMatch[1]}`;
  // API·쓰기 요청은 서버 창에 기록 (문제 확인용)
  if (apiMatch || req.method !== 'GET') res.on('finish', () => console.log(`[${new Date().toLocaleTimeString('ko-KR')}] ${req.method} ${req.url} → ${res.statusCode} (${req.socket.remoteAddress})`));
  if (pathname === '/api/ping' || pathname.endsWith('/api/ping')) return send(res, 200, { app: 'tutorbot' });
  if (pathname === '/api/deploy') return api(req, res).catch(e => send(res, 500, { error: e.message }));
  if (pathname === '/api/courses') return coursesApi(req, res).catch(e => send(res, 500, { error: e.message }));
  if (pathname === '/api/ai') return aiConfig(req, res).catch(e => send(res, 500, { error: e.message }));
  if (pathname === '/api/chat') return chat(req, res).catch(e => send(res, 500, { error: { message: e.message } }));
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
  serveFile(req, res, pathname);
}).listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(require('os').networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`튜터봇 서버 실행 중: ${['localhost', ...ips].map(h => `http://${h}:${PORT}`).join('  ')}`);
});
