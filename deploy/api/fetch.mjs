// GET /api/fetch?url=… → 구글 드라이브·문서 파일을 대신 내려받아 돌려줌 (교수 로그인 필요, 구글 주소만, 20MB까지)
// 브라우저는 다른 사이트(구글)의 파일을 직접 읽지 못해서, 교수 모드의 REFERENCE → URL 탭이 이 주소를 거칩니다.
import { createHash } from 'node:crypto';
import { json } from './_ai.mjs';

// 교수 로그인 토큰의 SHA-256 값 (server.js와 같음, 비밀번호 원문은 두지 않음)
const TOKEN_HASH = '19e34df315e4651ab2ffc9a4a0e2077779b3034261063e37e2834e657721991e';
const FETCH_HOSTS = /^(docs|drive|drive\.usercontent)\.google\.com$/i;

export async function GET(request) {
  const token = request.headers.get('x-tutorbot-token') || '';
  if (!token || createHash('sha256').update(token).digest('hex') !== TOKEN_HASH) return json(401, { error: '교수 로그인이 필요합니다' });
  let target;
  try { target = new URL(new URL(request.url).searchParams.get('url') || ''); } catch { return json(400, { error: '주소가 올바르지 않습니다' }); }
  if (target.protocol !== 'https:' || !FETCH_HOSTS.test(target.hostname)) return json(400, { error: '구글 드라이브·문서 주소만 받을 수 있습니다' });
  try {
    const r = await fetch(target, { redirect: 'follow' });
    if (!r.ok) return json(r.status, { error: `구글에서 받지 못했습니다 (HTTP ${r.status}) — 공유 설정을 확인하세요` });
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 20 * 1024 * 1024) return json(413, { error: '20MB가 넘는 파일입니다' });
    const cd = r.headers.get('content-disposition') || '';
    const name = (cd.match(/filename\*=UTF-8''([^;]+)/i) || [])[1] || (cd.match(/filename="?([^";]+)"?/i) || [])[1] || '';
    return new Response(buf, { headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'x-filename': name ? encodeURIComponent(decodeURIComponent(name)) : '', 'cache-control': 'no-store' } });
  } catch (e) {
    return json(502, { error: `구글에 연결할 수 없습니다 — ${e.message}` });
  }
}
