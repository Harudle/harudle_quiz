// 하루들 한컷퀴즈 로컬 개발 서버
// - 정적 파일(index.html, src/) 서빙
// - /api/* 는 Vercel 함수와 같은 코드(lib/routes.js)로 처리 — 데이터는 Supabase
import http from 'node:http';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PASSWORD, handleApiRequest, usingDefaultPassword } from './lib/routes.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

async function serveFile(res, relPath) {
  const filePath = path.resolve(ROOT, `.${relPath}`);
  if (!filePath.startsWith(ROOT + path.sep)) return false;
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
  return true;
}

async function handleStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '/index.html') return serveFile(res, '/index.html');
  if (pathname.startsWith('/src/') || pathname.startsWith('/public/')) return serveFile(res, pathname);
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApiRequest(req, res);
  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && (await handleStatic(req, res, url))) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    console.error(err);
    if (res.headersSent) return res.end();
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Error');
  }
});

server.listen(PORT, () => {
  console.log(`하루들 한컷퀴즈 → http://localhost:${PORT}`);
  console.log(`관리자 페이지   → http://localhost:${PORT}/#/admin`);
  if (!process.env.DATABASE_URL || !process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    console.warn('⚠️  Supabase 환경변수가 없어요. .env.example 을 복사해 .env 를 만들어주세요.');
  }
  if (usingDefaultPassword) {
    console.warn(`⚠️  ADMIN_PASSWORD 환경변수가 없어 기본 비밀번호(${DEFAULT_PASSWORD})를 사용 중이에요.`);
  }
});
