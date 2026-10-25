// GET /api/ai → 학생 화면 AI 사용 여부·제공자·모델 (키는 알려 주지 않음)
import { aiEnv, json } from './_ai.mjs';

export function GET() {
  const a = aiEnv();
  return json(200, a.ready ? { enabled: true, provider: a.provider, model: a.model, host: 'vercel' } : { enabled: false, host: 'vercel', reason: 'Vercel 환경 변수 AI_KEY·AI_PROVIDER·AI_MODEL을 설정하세요' });
}
