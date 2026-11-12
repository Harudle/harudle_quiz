// 하루들 한컷퀴즈 API — 로컬 서버(server.js)와 Vercel 함수(api/index.js)가 함께 씁니다.
// - 데이터는 Supabase (lib/store.js)
// - 정답 판정·점수 계산은 서버에서 (플레이어에게 정답을 미리 내려주지 않음)
// - /api/admin/* 는 ADMIN_PASSWORD 로 보호
import crypto from 'node:crypto';
import {
  CATEGORIES,
  DEFAULT_ROUND_SIZE,
  MAX_ROUND_SIZE,
  MAX_TRIES,
  NICKNAME_RULE,
  dayKey,
  hash,
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

/** 오늘의 한 판: 하루 동안 고정되고, 덜 출제된 문제를 우선 고릅니다. */
async function dailyRound(category) {
  assertCategory(category);
  const day = dayKey();
  let quizzes = await store.getRound(day, category);
  if (!quizzes.length) {
    const [pool, sizes, used] = await Promise.all([
      store.listQuizzes(category),
      store.getRoundSizes(),
      store.usageCounts(),
    ]);
    if (pool.length) {
      const key = `${day}:${category}`;
      const ids = [...pool]
        .sort((a, b) => (used[a.id] ?? 0) - (used[b.id] ?? 0) || hash(key + a.id) - hash(key + b.id))
        .slice(0, Math.min(roundSizeOf(category, sizes), pool.length))
        .map((q) => q.id);
      await store.createRound(day, category, ids);
      quizzes = await store.getRound(day, category);
    }
  }
  return { day, quizzes };
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
const shaHex = (s) => sha(s).toString('hex');

async function playerFromToken(token) {
  if (!token) return null;
  return store.findPlayerByTokenHash(shaHex(token));
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

function validateQuizInput(body) {
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
  const m = IMAGE_DATA_URL.exec(String(body.image ?? ''));
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
    throw new HttpError(409, '오늘의 문제가 바뀌었어요. 새로고침 후 다시 풀어주세요.');
  }
  let points = 0;
  let correct = 0;
  round.forEach((quiz, i) => {
    const item = items[i] ?? {};
    if (item.quizId !== quiz.id) throw new HttpError(409, '오늘의 문제가 바뀌었어요. 새로고침 후 다시 풀어주세요.');
    const guesses = item.guesses;
    if (!Array.isArray(guesses) || guesses.length < 1 || guesses.length > MAX_TRIES) {
      throw new HttpError(400, '풀이 기록이 올바르지 않아요.');
    }
    const texts = guesses.map((g) => String(g ?? '').slice(0, 60));
    const solved = isCorrect(texts.at(-1), quiz);
    if (texts.slice(0, -1).some((g) => isCorrect(g, quiz))) throw new HttpError(400, '풀이 기록이 올바르지 않아요.');
    if (!solved && texts.length !== MAX_TRIES) throw new HttpError(400, '아직 다 풀지 않았어요.');
    if (solved) correct += 1;
    points += pointsFor(texts.length, solved);
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
    const [counts, sizes, rounds] = await Promise.all([
      store.countQuizzes(),
      store.getRoundSizes(),
      store.getRoundIds(day),
    ]);
    const categories = Object.keys(CATEGORIES).map((key) => {
      const count = counts[key] ?? 0;
      return {
        key,
        count,
        roundSize: Math.min(roundSizeOf(key, sizes), count),
        // 오늘의 한 판이 이미 정해졌다면 그 문제들 (지난 기록과 비교용)
        dailyIds: rounds[key] ?? [],
      };
    });
    return sendJSON(res, 200, { day, categories });
  }

  if (method === 'GET' && parts[0] === 'categories' && parts[2] === 'daily') {
    const { day, quizzes } = await dailyRound(parts[1]);
    if (!quizzes.length) throw new HttpError(404, '아직 문제가 없어요.');
    return sendJSON(res, 200, { day, quizzes: quizzes.map(publicQuiz) });
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

  // 닉네임 등록
  if (method === 'POST' && parts[0] === 'players' && parts.length === 1) {
    const nickname = String((await readJSON(req)).nickname ?? '').trim().replace(/\s+/g, ' ');
    if (!NICKNAME_RULE.test(nickname)) {
      throw new HttpError(400, '닉네임은 2~12자 한글·영문·숫자로 지어주세요.');
    }
    const token = crypto.randomBytes(24).toString('base64url');
    const created = await store.insertPlayer({
      id: crypto.randomUUID(),
      nickname,
      nicknameNorm: normalize(nickname),
      tokenHash: shaHex(token),
    });
    if (!created) throw new HttpError(409, '이미 있는 닉네임이에요.');
    return sendJSON(res, 201, { token, nickname });
  }

  // 오늘의 한 판 결과 등록
  if (method === 'POST' && parts[0] === 'results' && parts.length === 1) {
    const body = await readJSON(req);
    const player = await playerFromToken(body.token);
    if (!player) throw new HttpError(401, '닉네임을 다시 등록해주세요.');
    assertCategory(body.category);
    const day = dayKey();
    if (body.day !== day) throw new HttpError(409, '이미 지난 문제라 랭킹에 올릴 수 없어요.');
    const round = await store.getRound(day, body.category);
    if (!round.length) throw new HttpError(409, '오늘의 문제가 바뀌었어요.');

    let result = await store.findResult(player.id, day, body.category);
    if (!result) {
      result = await store.saveResult({ playerId: player.id, day, category: body.category, ...gradeRound(round, body.items) });
    }
    const [me] = await store.rankings({ period: 'today', day, category: body.category, limit: 0, playerId: player.id });
    return sendJSON(res, 200, {
      nickname: player.nickname,
      points: result.points,
      correct: result.correct,
      total: result.total,
      rank: me?.rank ?? null,
      participants: me?.participants ?? 0,
    });
  }

  // 랭킹: ?period=today|all&limit=n  (X-Player-Token 이 있으면 내 순위도)
  if (method === 'GET' && parts[0] === 'rankings') {
    const period = url.searchParams.get('period') === 'all' ? 'all' : 'today';
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 100);
    const player = await playerFromToken(req.headers['x-player-token']);
    const rows = await store.rankings({ period, day: dayKey(), limit, playerId: player?.id });
    const rankings = {};
    for (const key of Object.keys(CATEGORIES)) {
      const mine = rows.filter((r) => r.category === key);
      const me = player ? mine.find((r) => r.playerId === player.id) : null;
      rankings[key] = {
        top: mine.filter((r) => r.pos <= limit).map(publicRow),
        participants: mine[0]?.participants ?? 0,
        me: me ? publicRow(me) : null,
      };
    }
    return sendJSON(res, 200, { day: dayKey(), period, rankings, me: player?.nickname ?? null });
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
