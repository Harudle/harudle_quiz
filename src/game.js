// 결과 계산·표시와 닉네임 (브라우저에 저장하지 않아요. 새로고침하면 처음부터예요.)
import { pointsFor } from './shared.js';

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

/** 🟩 한 번에 / 🟨 두 번째 / 🟧 세 번째 / 🟥 못 맞힘 */
export function itemEmoji(item) {
  if (!item.done) return '⬜';
  if (!item.solved) return '🟥';
  return ['🟩', '🟨', '🟧'][item.guesses.length - 1] ?? '🟧';
}

// ---- 닉네임 (이 탭이 열려 있는 동안만) ----
/** @type {{ token: string, nickname: string } | null} */
let player = null;

export const getPlayer = () => player;

export function setPlayer(next) {
  player = next;
}
