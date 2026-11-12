// 결과 계산·표시와 닉네임 (브라우저에 저장하지 않아요. 새로고침하면 처음부터예요.)
import { pointsFor } from './shared.js';

export function summarize(items) {
  return items.reduce(
    (acc, it) => ({
      correct: acc.correct + (it.solved ? 1 : 0),
      points: acc.points + pointsFor(it.solved),
      total: acc.total + 1,
    }),
    { correct: 0, points: 0, total: 0 },
  );
}

/** 맞히면 O, 못 맞히면 X */
export function itemMark(item) {
  return item.solved
    ? '<span class="scene-mark is-hit" aria-label="맞힘">O</span>'
    : '<span class="scene-mark is-miss" aria-label="못 맞힘">X</span>';
}

// ---- 닉네임 (이 탭이 열려 있는 동안만) ----
/** @type {{ token: string, nickname: string } | null} */
let player = null;

export const getPlayer = () => player;

export function setPlayer(next) {
  player = next;
}
