// 효과음 (소리 파일 없이 Web Audio 로 만들어요)
let ctx = null;

/** 브라우저는 사용자 동작 안에서만 소리를 켤 수 있어서, 답을 낼 때 미리 깨워둬요. */
export function unlockSound() {
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    ctx = null;
  }
}

/** 맞혔을 때: 도·미·솔 띠리링 */
export function playCorrect() {
  if (!ctx) return;
  const start = ctx.currentTime;
  [1046.5, 1318.5, 1568].forEach((freq, i) => {
    const at = start + i * 0.08;
    const length = i === 2 ? 0.45 : 0.2;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.22, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + length + 0.05);
  });
}
