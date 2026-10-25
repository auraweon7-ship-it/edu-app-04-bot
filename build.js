// 빌드: src의 HWPX 자리표시를 참고 앱(01 퀴즈 생성기)의 hwpx 템플릿으로 채워 단일 HTML 생성
const fs = require('fs');
const REF = process.argv[2];
const ref = fs.readFileSync(REF, 'utf8');
const line = ref.split('\n').find(l => l.startsWith('const HWPX_TPL = '));
const tpl = line.slice('const HWPX_TPL = '.length).replace(/;\s*$/, '');
JSON.parse(tpl);
const src = fs.readFileSync('src/04 AI 학습용 챗봇.src.html', 'utf8');
if (!src.includes('/*HWPX_TPL*/null')) throw new Error('placeholder missing');
const out = src.replace('/*HWPX_TPL*/null', () => tpl);
fs.writeFileSync('04 AI 학습용 챗봇.html', out);
// 서버 첫 주소(http://…:8765/)로 바로 열리도록 같은 내용을 index.html로도 저장
fs.writeFileSync('index.html', out);
console.log('ok', out.length);
