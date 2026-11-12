// 예전 로컬 저장소(data/db.json, data/uploads/)를 Supabase 로 옮깁니다.
// 여러 번 실행해도 이미 옮긴 데이터는 건너뛰어요.
//   npm run import-json            (data/ 폴더)
//   npm run import-json -- 경로     (다른 폴더)
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { normalize } from '../src/shared.js';
import { db, uploadImage } from '../lib/store.js';

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const dataDir = path.resolve(process.argv[2] ?? 'data');
const old = JSON.parse(await readFile(path.join(dataDir, 'db.json'), 'utf8'));
const sql = db();
const count = { quizzes: 0, daily: 0, settings: 0, players: 0, results: 0 };

for (const q of old.quizzes ?? []) {
  const file = `quizzes/${q.image}`;
  const buffer = await readFile(path.join(dataDir, 'uploads', q.image));
  await uploadImage(file, buffer, MIME[path.extname(q.image).toLowerCase()] ?? 'application/octet-stream', { upsert: true });
  const rows = await sql`
    insert into quizzes (id, category, answer, aliases, hint, image, aspect, created_at)
    values (${q.id}, ${q.category}, ${q.answer}, ${q.aliases ?? []}::text[], ${q.hint ?? ''}, ${file}, ${q.aspect ?? 1},
            ${new Date(q.createdAt ?? Date.now())})
    on conflict (id) do nothing
    returning id`;
  count.quizzes += rows.length;
}

for (const [key, value] of Object.entries(old.daily ?? {})) {
  const [day, category] = key.split(':');
  const ids = Array.isArray(value) ? value : [value];
  const rows = await sql`
    insert into daily_rounds (day, category, quiz_ids) values (${day}, ${category}, ${ids}::text[])
    on conflict do nothing
    returning day`;
  count.daily += rows.length;
}

for (const [category, n] of Object.entries(old.settings?.roundSize ?? {})) {
  const rows = await sql`
    insert into settings (category, round_size) values (${category}, ${n})
    on conflict do nothing
    returning category`;
  count.settings += rows.length;
}

for (const p of old.players ?? []) {
  const rows = await sql`
    insert into players (id, nickname, nickname_norm, token_hash, created_at)
    values (${p.id}, ${p.nickname}, ${normalize(p.nickname)}, ${p.tokenHash}, ${new Date(p.createdAt ?? Date.now())})
    on conflict do nothing
    returning id`;
  count.players += rows.length;
}

for (const r of old.results ?? []) {
  const rows = await sql`
    insert into results (player_id, day, category, points, correct, total, at)
    values (${r.playerId}, ${r.day}, ${r.category}, ${r.points}, ${r.correct}, ${r.total}, ${new Date(r.at ?? Date.now())})
    on conflict do nothing
    returning player_id`;
  count.results += rows.length;
}

await sql.end();
console.log('옮긴 데이터:', count);
