// SQL 마이그레이션 파일 하나를 트랜잭션으로 실행합니다. 중간에 실패하면 아무것도 바뀌지 않아요.
//   node --env-file=.env scripts/migrate.js supabase/migrations/001-nickname-per-category.sql
import { readFile } from 'node:fs/promises';
import { db } from '../lib/store.js';

const file = process.argv[2];
if (!file) {
  console.error('사용법: node --env-file=.env scripts/migrate.js <sql 파일>');
  process.exit(1);
}

const text = await readFile(file, 'utf8');
const sql = db();
await sql.begin((tx) => tx.unsafe(text));
await sql.end();
console.log(`실행했어요: ${file}`);
