// 브라우저와 서버(server.js)가 함께 쓰는 규칙입니다.
export const CATEGORIES = {
  movie: { label: '영화', emoji: '🎬', desc: '극장에서 본 그 장면' },
  drama: { label: '드라마', emoji: '📺', desc: '정주행했던 그 드라마' },
  anime: { label: '애니메이션', emoji: '🍥', desc: '덕심을 시험하는 한 컷' },
};

/** 한 문제당 제한 시간(초). 시간 안에는 몇 번이든 답할 수 있어요. */
export const TIME_LIMIT = 5;
/** 한 문제에 받을 수 있는 답 수 (서버 검증용 상한) */
export const MAX_GUESSES = 30;
/** 이만큼 틀리면 힌트를 볼 수 있어요. */
export const HINT_AFTER = 1;
/** 한 판에 푸는 문제 수 (관리자가 장르별로 바꿀 수 있어요) */
export const DEFAULT_ROUND_SIZE = 5;
export const MAX_ROUND_SIZE = 20;

/** 맞힌 문제마다 1점 */
export function pointsFor(solved) {
  return solved ? 1 : 0;
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
