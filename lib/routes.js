// 하루들 한컷퀴즈 API — 로컬 서버(server.js)와 Vercel 함수(api/index.js)가 함께 씁니다.
// - 데이터는 Supabase (lib/store.js)
// - 정답 판정·점수 계산은 서버에서 (플레이어에게 정답을 미리 내려주지 않음)
// - /api/admin/* 는 ADMIN_PASSWORD 로 보호
import crypto from 'node:crypto';
import {
  CATEGORIES,
  DEFAULT_ROUND_SIZE,
  MAX_GUESSES,
  MAX_ROUND_SIZE,
  NICKNAME_RULE,
  dayKey,
  isCorrect,
  normalize,
  pointsFor,
} from '../src/shared.js';
import * as store from './store.js';

const DEFAULT_PASSWORD = 'harudle-admin';
// Vercel 에 배포했는데 ADMIN_PASSWORD 가 없으면 기본 비밀번호를 쓰지 않고 관리자 API 를 막습니다.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? (process.env.VERCEL ? null : DEFAULT_PASSWORD);
export const usingDefaultPassword = ADMIN_PASSWORD === DEFAULT_PASSWORD;
export { DEFAULT_PASSWORD };

// Vercel 함수의 요청 본문 한도(4.5MB)보다 작게 잡습니다.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 플레이어용: 정답·힌트는 빼고 내려줍니다. */
function publicQuiz(q) {
  return {
    id: q.id,
    category: q.category,
    image: store.imageUrl(q.image),
    aspect: q.aspect,
    hasHint: Boolean(q.hint),
  };
}

function adminQuiz(q) {
  return { ...q, image: store.imageUrl(q.image) };
}

async function findQuiz(id) {
  const quiz = await store.getQuiz(id);
  if (!quiz) throw new HttpError(404, '문제를 찾을 수 없어요.');
  return quiz;
}

function assertCategory(category) {
  if (!Object.hasOwn(CATEGORIES, String(category))) throw new HttpError(404, '없는 카테고리예요.');
}

function roundSizeOf(category, sizes) {
  return sizes[category] ?? DEFAULT_ROUND_SIZE;
}

/** 한 판: 플레이할 때마다 문제를 랜덤으로 뽑습니다. */
async function randomRound(category) {
  assertCategory(category);
  const [pool, sizes] = await Promise.all([store.listQuizzes(category), store.getRoundSizes()]);
  return shuffle(pool).slice(0, Math.min(roundSizeOf(category, sizes), pool.length));
}

function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- 플레이어 · 랭킹 ----------
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

// 한 판 토큰: 서버가 내준 문제 묶음인지 결과 등록 때 확인합니다. (판마다 문제가 달라서)
const ROUND_KEY = sha(`round:${process.env.SUPABASE_SECRET_KEY ?? ADMIN_PASSWORD ?? 'local'}`);
const roundSig = (body) => crypto.createHmac('sha256', ROUND_KEY).update(body).digest();

function signRound(round) {
  const body = Buffer.from(JSON.stringify(round)).toString('base64url');
  return `${body}.${roundSig(body).toString('base64url')}`;
}

/** @returns {{ day: string, category: string, ids: string[] } | null} */
function readRound(token) {
  const [body, sig] = String(token ?? '').split('.');
  if (!body || !sig) return null;
  const given = Buffer.from(sig, 'base64url');
  const expected = roundSig(body);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

const publicRow = ({ rank, nickname, points, correct, total, rounds }) => ({ rank, nickname, points, correct, total, rounds });

// ---------- 요청 처리 유틸 ----------
function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

async function readJSON(req) {
  // Vercel 은 본문을 미리 읽어서 req.body 로 넘겨줍니다.
  let body;
  try {
    body = req.body;
  } catch {
    throw new HttpError(400, '잘못된 요청이에요.');
  }
  if (body !== undefined && body !== null && !Buffer.isBuffer(body) && typeof body !== 'string') return body;

  let text = body === undefined || body === null ? null : String(body);
  if (text === null) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, '사진 용량이 너무 커요.');
      chunks.push(chunk);
    }
    text = Buffer.concat(chunks).toString('utf8');
  }
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, '잘못된 요청이에요.');
  }
}

function requireAdmin(req) {
  if (!ADMIN_PASSWORD) throw new HttpError(503, 'ADMIN_PASSWORD 환경변수가 설정되지 않았어요.');
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !crypto.timingSafeEqual(sha(token), sha(ADMIN_PASSWORD))) {
    throw new HttpError(401, '관리자 비밀번호가 필요해요.');
  }
}

const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;

/** requireImage: 수정할 때는 그림을 안 보내면 원래 그림을 그대로 써요. (image: null) */
function validateQuizInput(body, { requireImage = true } = {}) {
  const category = String(body.category ?? '');
  const answer = String(body.answer ?? '').trim();
  const hint = String(body.hint ?? '').trim();
  const aliases = Array.isArray(body.aliases)
    ? body.aliases.map((a) => String(a).trim()).filter(Boolean).slice(0, 20)
    : [];
  const aspect = Number(body.aspect);

  if (!Object.hasOwn(CATEGORIES, category)) throw new HttpError(400, '카테고리를 골라주세요.');
  if (!answer || answer.length > 60) throw new HttpError(400, '정답은 1~60자로 입력해주세요.');
  if (hint.length > 80) throw new HttpError(400, '힌트는 80자 이내로 입력해주세요.');
  const raw = String(body.image ?? '');
  if (!raw && !requireImage) return { category, answer, aliases, hint, image: null, aspect: null };
  const m = IMAGE_DATA_URL.exec(raw);
  if (!m) throw new HttpError(400, '문제 그림을 올려주세요.');
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) throw new HttpError(413, '사진 용량이 너무 커요.');

  return {
    category,
    answer,
    aliases,
    hint,
    image: { ext: m[1] === 'jpeg' ? 'jpg' : m[1], type: `image/${m[1]}`, buffer },
    aspect: Number.isFinite(aspect) && aspect > 0.05 && aspect < 20 ? aspect : 1,
  };
}

/** 한 판 결과를 서버에서 다시 채점합니다. */
function gradeRound(round, items) {
  if (!Array.isArray(items) || items.length !== round.length) {
    throw new HttpError(400, '풀이 기록이 올바르지 않아요.');
  }
  let points = 0;
  let correct = 0;
  round.forEach((quiz, i) => {
    const item = items[i] ?? {};
    if (item.quizId !== quiz.id) throw new HttpError(400, '풀이 기록이 올바르지 않아요.');
    const guesses = item.guesses;
    // 시간 제한 안에서는 몇 번이든 답할 수 있어요. (시간 초과·패스면 답이 없을 수도 있어요)
    if (!Array.isArray(guesses) || guesses.length > MAX_GUESSES) {
      throw new HttpError(400, '풀이 기록이 올바르지 않아요.');
    }
    const texts = guesses.map((g) => String(g ?? '').slice(0, 60));
    const solved = texts.length > 0 && isCorrect(texts.at(-1), quiz);
    if (texts.slice(0, -1).some((g) => isCorrect(g, quiz))) throw new HttpError(400, '풀이 기록이 올바르지 않아요.');
    if (solved) correct += 1;
    points += pointsFor(solved);
  });
  return { points, correct, total: round.length };
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // 'api' 제외
  const method = req.method;

  // ----- 플레이어 -----
  if (method === 'GET' && parts[0] === 'categories' && parts.length === 1) {
    const day = dayKey();
    const [counts, sizes] = await Promise.all([store.countQuizzes(), store.getRoundSizes()]);
    const categories = Object.keys(CATEGORIES).map((key) => {
      const count = counts[key] ?? 0;
      return {
        key,
        count,
        roundSize: Math.min(roundSizeOf(key, sizes), count),
      };
    });
    return sendJSON(res, 200, { day, categories });
  }

  if (method === 'GET' && parts[0] === 'categories' && parts[2] === 'round') {
    const quizzes = await randomRound(parts[1]);
    if (!quizzes.length) throw new HttpError(404, '아직 문제가 없어요.');
    const round = signRound({ day: dayKey(), category: parts[1], ids: quizzes.map((q) => q.id) });
    return sendJSON(res, 200, { quizzes: quizzes.map(publicQuiz), round });
  }

  if (method === 'GET' && parts[0] === 'categories' && parts[2] === 'practice') {
    assertCategory(parts[1]);
    const [pool, sizes] = await Promise.all([store.listQuizzes(parts[1]), store.getRoundSizes()]);
    if (!pool.length) throw new HttpError(404, '아직 문제가 없어요.');
    const quizzes = shuffle(pool).slice(0, Math.min(roundSizeOf(parts[1], sizes), pool.length));
    return sendJSON(res, 200, { quizzes: quizzes.map(publicQuiz) });
  }

  // 지금까지 출제된 장면 (오늘 판은 제외 — 오늘 것은 다 푼 사람만 브라우저에서 봅니다)
  if (method === 'GET' && parts[0] === 'categories' && parts[2] === 'gallery') {
    assertCategory(parts[1]);
    const today = dayKey();
    const rounds = (await store.pastRounds(parts[1], today, 60)).map(({ day, quizzes }) => ({
      day,
      scenes: quizzes.map((q) => ({ ...publicQuiz(q), answer: q.answer })),
    }));
    return sendJSON(res, 200, { day: today, rounds });
  }

  if (parts[0] === 'quizzes' && parts[1]) {
    const quiz = await findQuiz(parts[1]);
    if (method === 'GET' && parts.length === 2) return sendJSON(res, 200, { quiz: publicQuiz(quiz) });
    if (method === 'POST' && parts[2] === 'guess') {
      const { guess } = await readJSON(req);
      const correct = isCorrect(guess, quiz);
      return sendJSON(res, 200, correct ? { correct, answer: quiz.answer } : { correct });
    }
    if (method === 'POST' && parts[2] === 'hint') return sendJSON(res, 200, { hint: quiz.hint });
    if (method === 'POST' && parts[2] === 'answer') return sendJSON(res, 200, { answer: quiz.answer });
  }

  // 한 판 결과를 닉네임과 함께 등록 (한 기기로 여러 명이 돌아가며 해서, 판마다 닉네임을 새로 쳐요)
  // 닉네임은 장르마다 따로라서 다른 장르에서는 같은 닉네임을 또 쓸 수 있어요.
  if (method === 'POST' && parts[0] === 'results' && parts.length === 1) {
    const body = await readJSON(req);
    assertCategory(body.category);
    const nickname = String(body.nickname ?? '').trim().replace(/\s+/g, ' ');
    if (!NICKNAME_RULE.test(nickname)) {
      throw new HttpError(400, '닉네임은 2~12자 한글·영문·숫자로 지어주세요.');
    }
    const round = readRound(body.round);
    if (!round || round.category !== body.category) throw new HttpError(400, '풀이 기록이 올바르지 않아요.');
    const day = dayKey();
    if (round.day !== day) throw new HttpError(409, '이미 지난 판이라 랭킹에 올릴 수 없어요.');
    const quizzes = await store.getQuizzesByIds(round.ids);
    if (quizzes.length !== round.ids.length) throw new HttpError(409, '그새 문제가 바뀌었어요. 다시 풀어주세요.');

    const playerId = crypto.randomUUID();
    const result = await store.registerResult({
      playerId,
      category: body.category,
      nickname,
      nicknameNorm: normalize(nickname),
      day,
      ...gradeRound(quizzes, body.items),
    });
    if (!result) throw new HttpError(409, `${CATEGORIES[body.category].label}에 이미 있는 닉네임이에요.`);
    const [me] = await store.rankings({ category: body.category, limit: 0, playerIds: [playerId] });
    return sendJSON(res, 200, {
      nickname,
      points: result.points,
      correct: result.correct,
      total: result.total,
      rank: me?.rank ?? null,
      participants: me?.participants ?? 0,
    });
  }

  // 랭킹: ?limit=n
  if (method === 'GET' && parts[0] === 'rankings') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 100);
    const rows = await store.rankings({ limit });
    const rankings = {};
    for (const key of Object.keys(CATEGORIES)) {
      const mine = rows.filter((r) => r.category === key);
      rankings[key] = {
        top: mine.map(publicRow),
        participants: mine[0]?.participants ?? 0,
      };
    }
    return sendJSON(res, 200, { rankings });
  }

  // ----- 관리자 -----
  if (parts[0] === 'admin') {
    requireAdmin(req);

    if (method === 'POST' && parts[1] === 'login') return sendJSON(res, 200, { ok: true });

    if (parts[1] === 'settings') {
      if (method === 'PUT') {
        const { roundSize = {} } = await readJSON(req);
        const updates = {};
        for (const key of Object.keys(CATEGORIES)) {
          if (roundSize[key] === undefined) continue;
          const n = Number(roundSize[key]);
          if (!Number.isInteger(n) || n < 1 || n > MAX_ROUND_SIZE) {
            throw new HttpError(400, `한 판 문제 수는 1~${MAX_ROUND_SIZE} 사이로 정해주세요.`);
          }
          updates[key] = n;
        }
        await store.saveRoundSizes(updates);
      }
      if (method === 'GET' || method === 'PUT') {
        const sizes = await store.getRoundSizes();
        const roundSize = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, roundSizeOf(k, sizes)]));
        return sendJSON(res, 200, { roundSize, max: MAX_ROUND_SIZE });
      }
    }

    // 랭킹 초기화: GET 은 장르별 닉네임 수, DELETE /admin/rankings/:category 는 그 장르 기록·닉네임 삭제
    if (parts[1] === 'rankings') {
      if (method === 'GET' && parts.length === 2) {
        const counts = await store.rankingCounts();
        return sendJSON(res, 200, { counts: Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, counts[k] ?? 0])) });
      }
      if (method === 'DELETE' && parts.length === 3) {
        assertCategory(parts[2]);
        const deleted = await store.resetRanking(parts[2]);
        return sendJSON(res, 200, { deleted });
      }
    }

    if (parts[1] === 'quizzes' && parts.length === 2) {
      if (method === 'GET') {
        const quizzes = (await store.listQuizzes()).map(adminQuiz);
        return sendJSON(res, 200, { quizzes });
      }
      if (method === 'POST') {
        const { image, ...input } = validateQuizInput(await readJSON(req));
        const id = crypto.randomUUID();
        const file = `quizzes/${id}.${image.ext}`;
        await store.uploadImage(file, image.buffer, image.type);
        const quiz = { ...input, id, image: file, createdAt: Date.now() };
        try {
          await store.insertQuiz(quiz);
        } catch (err) {
          await store.deleteImage(file).catch(() => {});
          throw err;
        }
        return sendJSON(res, 201, { quiz: adminQuiz(quiz) });
      }
    }

    if (method === 'GET' && parts[1] === 'quizzes' && parts[2] && parts.length === 3) {
      return sendJSON(res, 200, { quiz: adminQuiz(await findQuiz(parts[2])) });
    }

    // 문제 수정: 그림을 새로 보내면 바꾸고, 안 보내면 원래 그림을 그대로 둬요.
    if (method === 'PUT' && parts[1] === 'quizzes' && parts[2] && parts.length === 3) {
      const before = await findQuiz(parts[2]);
      const { image, ...input } = validateQuizInput(await readJSON(req), { requireImage: false });
      // 그림은 1년 캐시라서 바꿀 때는 새 파일 이름으로 올려요.
      const file = image ? `quizzes/${before.id}-${Date.now()}.${image.ext}` : null;
      if (image) await store.uploadImage(file, image.buffer, image.type);
      let quiz;
      try {
        quiz = await store.updateQuiz(before.id, { ...input, image: file });
      } catch (err) {
        if (file) await store.deleteImage(file).catch(() => {});
        throw err;
      }
      if (!quiz) throw new HttpError(404, '문제를 찾을 수 없어요.');
      if (file) await store.deleteImage(before.image).catch((err) => console.error(err));
      return sendJSON(res, 200, { quiz: adminQuiz(quiz) });
    }

    if (method === 'DELETE' && parts[1] === 'quizzes' && parts[2]) {
      const quiz = await store.deleteQuiz(parts[2]);
      if (!quiz) throw new HttpError(404, '문제를 찾을 수 없어요.');
      await store.deleteImage(quiz.image).catch((err) => console.error(err));
      return sendJSON(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, '없는 API예요.');
}

/** /api/* 요청 하나를 처리합니다. */
export async function handleApiRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  // Vercel 에서는 vercel.json 의 rewrite 가 /api/a/b 를 /api?__path=a/b 로 넘겨줍니다.
  const rewritten = url.searchParams.get('__path');
  if (rewritten !== null) {
    url.pathname = `/api/${rewritten}`;
    url.searchParams.delete('__path');
  }
  try {
    await handleApi(req, res, url);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (res.headersSent) return res.end();
    sendJSON(res, status, { message: status === 500 ? '서버 오류가 났어요.' : err.message });
  }
}
