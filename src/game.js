// 플레이어 기록·닉네임(localStorage)과 결과 표시
import { pointsFor } from './shared.js';

const RECORD_KEY = 'harudle-quiz:rounds';
const PLAYER_KEY = 'harudle-quiz:player';

function readJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 저장이 막힌 환경(시크릿 모드 등)에서도 게임은 계속 진행됩니다.
  }
}

/**
 * 오늘의 한 판 기록
 * @typedef {{ guesses: string[], solved: boolean, done: boolean, answer: string|null }} Item
 * @typedef {{ quizIds: string[], items: Item[], current: number, done: boolean,
 *             submitted: null | { rank: number|null, participants: number } }} RoundRecord
 * @returns {RoundRecord|null}
 */
export function getRoundRecord(category, day) {
  return readJSON(RECORD_KEY, {})[`${day}:${category}`] ?? null;
}

export function saveRoundRecord(category, day, record) {
  const all = readJSON(RECORD_KEY, {});
  all[`${day}:${category}`] = record;
  writeJSON(RECORD_KEY, all);
}

export const sameIds = (a = [], b = []) => a.length === b.length && a.every((id, i) => id === b[i]);

export function summarize(items) {
  return items.reduce(
    (acc, it) => ({
      correct: acc.correct + (it.solved ? 1 : 0),
      points: acc.points + pointsFor(it.guesses.length, it.solved),
      total: acc.total + 1,
    }),
    { correct: 0, points: 0, total: 0 },
  );
}

export function getStats() {
  const rounds = Object.values(readJSON(RECORD_KEY, {})).filter((r) => r?.done && Array.isArray(r.items));
  return rounds.reduce(
    (acc, r) => {
      const s = summarize(r.items);
      return { rounds: acc.rounds + 1, correct: acc.correct + s.correct, total: acc.total + s.total };
    },
    { rounds: 0, correct: 0, total: 0 },
  );
}

/** 🟩 한 번에 / 🟨 두 번째 / 🟧 세 번째 / 🟥 못 맞힘 */
export function itemEmoji(item) {
  if (!item.done) return '⬜';
  if (!item.solved) return '🟥';
  return ['🟩', '🟨', '🟧'][item.guesses.length - 1] ?? '🟧';
}

export const roundEmoji = (items) => items.map(itemEmoji).join('');

// ---- 닉네임 ----
/** @returns {{ token: string, nickname: string } | null} */
export function getPlayer() {
  const p = readJSON(PLAYER_KEY, null);
  return p?.token && p?.nickname ? p : null;
}

export function setPlayer(player) {
  if (player) writeJSON(PLAYER_KEY, player);
  else {
    try {
      localStorage.removeItem(PLAYER_KEY);
    } catch {
      // 무시
    }
  }
}
