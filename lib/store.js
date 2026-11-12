// Supabase 저장소 — Postgres(문제·한 판·랭킹)와 Storage(문제 그림)
// 서버에서만 씁니다. 브라우저에는 접속 정보가 내려가지 않아요.
import postgres from 'postgres';

const BUCKET = process.env.SUPABASE_BUCKET ?? 'quiz-images';

let client;
/** 첫 쿼리 때 연결합니다. Vercel 함수가 살아 있는 동안은 연결을 재사용해요. */
export function db() {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL 환경변수가 없어요. .env.example 을 참고해주세요.');
    client = postgres(url, {
      prepare: false, // Supabase 트랜잭션 풀러(6543 포트)는 prepared statement 를 지원하지 않아요.
      max: 3,
      idle_timeout: 20,
      onnotice: () => {}, // "이미 있어요, 건너뛸게요" 같은 안내는 찍지 않아요.
      ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : 'require',
    });
  }
  return client;
}

const toQuiz = (r) => ({
  id: r.id,
  category: r.category,
  answer: r.answer,
  aliases: r.aliases,
  hint: r.hint,
  image: r.image,
  aspect: r.aspect,
  createdAt: r.created_at.getTime(),
});

const toResult = (r) => ({
  playerId: r.player_id,
  day: r.day,
  category: r.category,
  points: r.points,
  correct: r.correct,
  total: r.total,
  at: r.at.getTime(),
});

// ---------- 문제 ----------
export async function listQuizzes(category) {
  const sql = db();
  const rows = category
    ? await sql`select * from quizzes where category = ${category} order by created_at desc`
    : await sql`select * from quizzes order by created_at desc`;
  return rows.map(toQuiz);
}

export async function getQuiz(id) {
  const [row] = await db()`select * from quizzes where id = ${id}`;
  return row ? toQuiz(row) : null;
}

/** { category: 문제 수 } */
export async function countQuizzes() {
  const rows = await db()`select category, count(*)::int as n from quizzes group by category`;
  return Object.fromEntries(rows.map((r) => [r.category, r.n]));
}

export async function insertQuiz(q) {
  await db()`
    insert into quizzes (id, category, answer, aliases, hint, image, aspect, created_at)
    values (${q.id}, ${q.category}, ${q.answer}, ${q.aliases}::text[], ${q.hint}, ${q.image}, ${q.aspect},
            ${new Date(q.createdAt)})`;
}

/** 주어진 순서대로 문제를 돌려줍니다. (지워진 문제는 빠져요) */
export async function getQuizzesByIds(ids) {
  const rows = await db()`select * from quizzes where id = any (${ids}::text[])`;
  const byId = new Map(rows.map((r) => [r.id, toQuiz(r)]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/** 지운 문제를 돌려줍니다. 없으면 null */
export async function deleteQuiz(id) {
  const [row] = await db()`delete from quizzes where id = ${id} returning *`;
  return row ? toQuiz(row) : null;
}

// ---------- 설정 ----------
/** { category: 한 판 문제 수 } (관리자가 정한 것만) */
export async function getRoundSizes() {
  const rows = await db()`select category, round_size from settings`;
  return Object.fromEntries(rows.map((r) => [r.category, r.round_size]));
}

export async function saveRoundSizes(sizes) {
  const rows = Object.entries(sizes).map(([category, round_size]) => ({ category, round_size }));
  if (!rows.length) return;
  const sql = db();
  await sql`
    insert into settings ${sql(rows, 'category', 'round_size')}
    on conflict (category) do update set round_size = excluded.round_size`;
}

// ---------- 지난 판 (예전 고정 출제 기록, 지난 장면 페이지용) ----------
/** beforeDay 이전에 출제된 한 판들 (최근 것부터) */
export async function pastRounds(category, beforeDay, limit) {
  const rows = await db()`
    select d.day, q.* from (
      select day, quiz_ids from daily_rounds
      where category = ${category} and day < ${beforeDay}
      order by day desc limit ${limit}
    ) d
    cross join lateral unnest(d.quiz_ids) with ordinality as u(id, ord)
    join quizzes q on q.id = u.id
    order by d.day desc, u.ord`;
  const rounds = new Map();
  for (const r of rows) {
    if (!rounds.has(r.day)) rounds.set(r.day, []);
    rounds.get(r.day).push(toQuiz(r));
  }
  return [...rounds].map(([day, quizzes]) => ({ day, quizzes }));
}

// ---------- 닉네임 · 결과 ----------
/**
 * 한 판 결과를 닉네임과 함께 등록합니다. (판마다 새 사람이 닉네임을 쳐요)
 * 그 장르에 같은 닉네임이 이미 있으면 아무것도 저장하지 않고 null 을 돌려줘요.
 */
export async function registerResult({ playerId, category, nickname, nicknameNorm, day, points, correct, total }) {
  try {
    return await db().begin(async (sql) => {
      await sql`
        insert into players (id, category, nickname, nickname_norm, token_hash)
        values (${playerId}, ${category}, ${nickname}, ${nicknameNorm}, ${playerId})`;
      const [row] = await sql`
        insert into results (player_id, day, category, points, correct, total)
        values (${playerId}, ${day}, ${category}, ${points}, ${correct}, ${total})
        returning *`;
      return toResult(row);
    });
  } catch (err) {
    if (err.code === '23505') return null;
    throw err;
  }
}

/** { category: 등록된 닉네임 수 } */
export async function rankingCounts() {
  const rows = await db()`select category, count(*)::int as n from players group by category`;
  return Object.fromEntries(rows.map((r) => [r.category, r.n]));
}

/**
 * 장르 랭킹을 초기화합니다. 그 장르의 기록과 닉네임을 모두 지워서 같은 닉네임을 다시 쓸 수 있어요.
 * 지운 닉네임 수를 돌려줘요.
 */
export async function resetRanking(category) {
  return db().begin(async (sql) => {
    await sql`delete from results where category = ${category}`;
    const { count } = await sql`delete from players where category = ${category}`;
    return count;
  });
}

/**
 * 장르별 누적 랭킹. 같은 점수·정답 수면 같은 순위 (1, 2, 2, 4 ...)
 * 장르마다 위에서 limit 명과 playerIds 의 줄을 돌려줍니다.
 */
export async function rankings({ limit, playerIds = [], category = null }) {
  const sql = db();
  const rows = await sql`
    with totals as (
      select category, player_id,
        sum(points)::int as points, sum(correct)::int as correct, sum(total)::int as total,
        count(*)::int as rounds, min(at) as at
      from results
      ${category ? sql`where category = ${category}` : sql``}
      group by category, player_id
    ), ranked as (
      select t.*, p.nickname,
        rank() over (partition by t.category order by t.points desc, t.correct desc)::int as rank,
        row_number() over (partition by t.category order by t.points desc, t.correct desc, t.at)::int as pos,
        count(*) over (partition by t.category)::int as participants
      from totals t join players p on p.id = t.player_id
    )
    select * from ranked
    where pos <= ${limit} ${playerIds.length ? sql`or player_id = any (${playerIds}::text[])` : sql``}
    order by category, pos`;
  return rows.map((r) => ({
    category: r.category,
    playerId: r.player_id,
    nickname: r.nickname,
    points: r.points,
    correct: r.correct,
    total: r.total,
    rounds: r.rounds,
    rank: r.rank,
    pos: r.pos,
    participants: r.participants,
  }));
}

// ---------- 문제 그림 (Supabase Storage) ----------
function storage(pathname) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!base || !key) throw new Error('SUPABASE_URL, SUPABASE_SECRET_KEY 환경변수가 없어요. .env.example 을 참고해주세요.');
  return {
    url: `${base.replace(/\/$/, '')}/storage/v1${pathname}`,
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  };
}

export function imageUrl(file) {
  const base = process.env.SUPABASE_URL ?? '';
  return `${base.replace(/\/$/, '')}/storage/v1/object/public/${BUCKET}/${file}`;
}

export async function uploadImage(file, buffer, contentType, { upsert = false } = {}) {
  const { url, headers } = storage(`/object/${BUCKET}/${file}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': contentType,
      'Cache-Control': 'max-age=31536000',
      'x-upsert': String(upsert),
    },
    body: buffer,
  });
  if (!res.ok) throw new Error(`그림 업로드 실패 (${res.status}): ${await res.text()}`);
}

export async function deleteImage(file) {
  const { url, headers } = storage(`/object/${BUCKET}`);
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [file] }),
  });
  if (!res.ok) throw new Error(`그림 삭제 실패 (${res.status}): ${await res.text()}`);
}
