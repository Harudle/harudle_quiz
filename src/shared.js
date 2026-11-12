// 브라우저와 서버(server.js)가 함께 쓰는 규칙입니다.
export const CATEGORIES = {
  movie: { label: '영화', emoji: '🎬', desc: '극장에서 본 그 장면' },
  drama: { label: '드라마', emoji: '📺', desc: '정주행했던 그 드라마' },
  anime: { label: '애니', emoji: '🍥', desc: '덕심을 시험하는 한 컷' },
};

/** 한 문제당 기회 */
export const MAX_TRIES = 3;
/** 이만큼 틀리면 힌트를 볼 수 있어요. */
export const HINT_AFTER = 1;
/** 한 판에 푸는 문제 수 (관리자가 장르별로 바꿀 수 있어요) */
export const DEFAULT_ROUND_SIZE = 5;
export const MAX_ROUND_SIZE = 20;

/** 첫 번째 기회에 맞히면 3점, 두 번째 2점, 세 번째 1점 */
export function pointsFor(tries, solved) {
  return solved ? MAX_TRIES - tries + 1 : 0;
}

export const NICKNAME_RULE = /^[\p{L}\p{N} _.-]{2,12}$/u;

/** 띄어쓰기·특수문자·대소문자를 무시하고 비교합니다. */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function isCorrect(guess, quiz) {
  const g = normalize(guess);
  if (!g) return false;
  return [quiz.answer, ...(quiz.aliases ?? [])].some((a) => normalize(a) === g);
}

/** 한국 시간 기준 날짜 (YYYY-MM-DD) */
export function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(date);
}

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
