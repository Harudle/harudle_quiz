import * as api from './api.js';
import { compressImage, loadImage } from './image.js';
import { CATEGORIES, HINT_AFTER, NICKNAME_RULE, TIME_LIMIT, normalize } from './shared.js';
import { getPlayer, itemMark, setPlayer, summarize } from './game.js';

const view = document.getElementById('view');
const headerRight = document.getElementById('header-right');
const toastEl = document.getElementById('toast');

// ---------- 공통 유틸 ----------
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

let toastTimer;
/** tone: 'miss' 이면 틀렸을 때의 붉은 토스트 */
function toast(message, tone = '') {
  toastEl.textContent = message;
  toastEl.classList.toggle('is-miss', tone === 'miss');
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function formatDay(day, withWeekday = true) {
  const [y, m, d] = day.split('-').map(Number);
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][new Date(y, m - 1, d).getDay()];
  return `${m}월 ${d}일${withWeekday ? ` ${weekday}요일` : ''}`;
}

const queryOf = () => new URLSearchParams(location.hash.split('?')[1] ?? '');
const ARROW = '<span class="arrow" aria-hidden="true">→</span>';
const MEDALS = ['🥇', '🥈', '🥉'];
const chip = (key) => `<span class="chip">${CATEGORIES[key].emoji} ${CATEGORIES[key].label}</span>`;

/** 하루들 엽서처럼 살짝 기울어진 액자 */
const frame = (body, extraClass = '') => `<div class="frame ${extraClass}"><div class="frame-inner">${body}</div></div>`;

/** 사진 크게 보기 (정답 캡션 선택) */
function openZoom(src, caption = '') {
  let dialog = document.querySelector('dialog.zoom');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.className = 'zoom';
    dialog.innerHTML = '<img alt="" /><p class="zoom-caption"></p><button type="button" class="zoom-close" aria-label="닫기">✕</button>';
    dialog.addEventListener('click', () => dialog.close());
    document.body.append(dialog);
  }
  dialog.querySelector('img').src = src;
  dialog.querySelector('img').alt = caption || '크게 보기';
  dialog.querySelector('.zoom-caption').textContent = caption;
  dialog.querySelector('.zoom-caption').hidden = !caption;
  dialog.showModal();
}

function rankList(rows, meNickname, emptyText) {
  if (!rows.length) return `<p class="rank-empty">${emptyText}</p>`;
  return `<ol class="rank-list">${rows
    .map(
      (r) => `
      <li class="${r.nickname === meNickname ? 'is-me' : ''}">
        <span class="rank-no">${r.rank <= 3 ? MEDALS[r.rank - 1] : r.rank}</span>
        <span class="rank-name">${esc(r.nickname)}</span>
        <span class="rank-score"><b>${r.points}</b>점 <small>${r.correct}/${r.total}</small></span>
      </li>`,
    )
    .join('')}</ol>`;
}

// ---------- 라우터 ----------
const CAT = '(movie|drama|anime)';
const routes = [
  { pattern: /^\/$/, render: renderHome },
  { pattern: new RegExp(`^/play/${CAT}$`), render: (m) => renderPlay(m[1], 'daily') },
  { pattern: new RegExp(`^/practice/${CAT}(?:/([\\w-]+))?$`), render: (m) => renderPlay(m[1], 'practice', m[2]) },
  { pattern: /^\/ranking$/, render: renderRanking },
  { pattern: new RegExp(`^/gallery/${CAT}$`), render: (m) => renderGallery(m[1]) },
  { pattern: /^\/admin$/, render: renderAdminList, admin: true },
  { pattern: /^\/admin\/new$/, render: renderAdminNew, admin: true },
];

let cleanup = null;

/** keepScroll: 같은 화면을 다시 그릴 때 스크롤 위치를 그대로 둡니다. (관리자 삭제 등) */
async function router({ keepScroll = false } = {}) {
  const scrollY = keepScroll ? window.scrollY : 0;
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/';
  const route = routes.find((r) => r.pattern.test(path));
  if (!route) {
    location.hash = '#/';
    return;
  }
  cleanup?.();
  cleanup = null;
  document.querySelector('dialog.zoom[open]')?.close();

  const isAdmin = Boolean(route.admin);
  document.body.classList.toggle('is-admin', isAdmin);
  renderHeader(isAdmin);
  if (!keepScroll) window.scrollTo(0, 0);

  try {
    if (isAdmin && !api.getAdminToken()) renderAdminLogin();
    else await route.render(path.match(route.pattern));
  } catch (err) {
    if (err.status === 401 && isAdmin) {
      api.setAdminToken(null);
      renderHeader(true);
      renderAdminLogin('세션이 만료됐어요. 다시 로그인해주세요.');
    } else {
      console.error(err);
      view.innerHTML = `
        <section class="center-card card">
          <p class="big-emoji" aria-hidden="true">🫠</p>
          <h1 class="title-sm">앗, 문제가 생겼어요</h1>
          <p class="lead">${esc(err.message)}</p>
          <a class="btn btn-dark" href="#/">홈으로 ${ARROW}</a>
        </section>`;
    }
  }
  if (keepScroll) window.scrollTo(0, scrollY);
  view.focus({ preventScroll: true });
}

function renderHeader(isAdmin) {
  if (!isAdmin) {
    headerRight.innerHTML = '<a class="header-link" href="#/ranking">랭킹</a><span class="pill-badge">오늘의 한컷퀴즈</span>';
    return;
  }
  const authed = Boolean(api.getAdminToken());
  headerRight.innerHTML = `
    ${authed ? '<button type="button" class="header-link" data-action="logout">로그아웃</button>' : ''}
    <span class="pill-badge">관리자</span>`;
  headerRight.querySelector('[data-action="logout"]')?.addEventListener('click', () => {
    api.setAdminToken(null);
    toast('로그아웃했어요');
    router();
  });
}

window.addEventListener('hashchange', () => router());
router();

// =====================================================================
// 홈
// =====================================================================
async function renderHome() {
  const { categories } = await api.getCategories();
  const firstAvailable = categories.find((c) => c.count)?.key;
  let selected = firstAvailable ?? 'movie';

  const options = categories
    .map(({ key, count, roundSize }) => {
      const c = CATEGORIES[key];
      return `
        <label class="option ${count ? '' : 'is-disabled'}">
          <input type="radio" name="category" value="${key}" ${key === selected ? 'checked' : ''} ${count ? '' : 'disabled'} />
          <span class="option-emoji" aria-hidden="true">${c.emoji}</span>
          <span class="option-body">
            <span class="option-title">${c.label}</span>
            <span class="option-desc">${count ? `총 ${count}개 문제 중 ${roundSize}개가 출제돼요` : c.desc}</span>
          </span>
          ${count ? '' : '<span class="status status-empty">준비 중</span>'}
        </label>`;
    })
    .join('');

  view.innerHTML = `
    <div class="split split-single">
      <section class="side">
        <h1 class="title">그림 한 컷 보고<br /><mark>제목</mark>을 맞혀볼까요?</h1>
        <p class="lead">문제마다 ${TIME_LIMIT}초! 시간 안에는 몇 번이든 맞혀보세요.</p>

        <form class="card home-card">
          <p class="card-q">어떤 장르의 문제를 풀까요?</p>
          <fieldset class="options">
            <legend class="sr-only">카테고리</legend>
            ${options}
          </fieldset>
        </form>

        <button type="button" class="btn btn-dark btn-block" data-action="start" ${firstAvailable ? '' : 'disabled'}>
          <span class="start-label"></span> ${ARROW}
        </button>
        <p class="footnote"><a href="#/admin">관리자</a></p>
      </section>
    </div>

    <section class="board">
      <div class="board-head">
        <h2 class="title-sm">장르별 <mark>랭킹</mark></h2>
      </div>
      <div class="board-grid"><p class="rank-empty">불러오는 중…</p></div>
    </section>
  `;

  // 시작 버튼
  const startBtn = view.querySelector('[data-action="start"]');
  const label = startBtn.querySelector('.start-label');
  const updateLabel = () => {
    if (!firstAvailable) {
      label.textContent = '아직 문제가 없어요';
      return;
    }
    label.textContent = `${CATEGORIES[selected].label} 문제 풀기`;
  };
  updateLabel();
  view.querySelectorAll('input[name="category"]').forEach((input) =>
    input.addEventListener('change', () => {
      selected = input.value;
      updateLabel();
    }),
  );
  startBtn.addEventListener('click', () => {
    location.hash = `#/play/${selected}`;
  });

  // 랭킹 보드
  const board = view.querySelector('.board-grid');
  const player = getPlayer();
  const loadBoard = async () => {
    try {
      const { rankings } = await api.getRankings(5, player?.token);
      board.innerHTML = Object.entries(CATEGORIES)
        .map(
          ([key, c]) => `
          <div class="card board-card">
            <p class="board-title">${c.emoji} ${c.label}</p>
            ${rankList(rankings[key].top, player?.nickname, '첫 번째 주인공이 되어보세요')}
            <a class="board-more" href="#/ranking?c=${key}">전체 순위 ${ARROW}</a>
          </div>`,
        )
        .join('');
    } catch (err) {
      board.innerHTML = `<p class="rank-empty">${esc(err.message)}</p>`;
    }
  };
  loadBoard();
}

// =====================================================================
// 퀴즈 한 판
// =====================================================================
async function renderPlay(category, mode, quizId) {
  const c = CATEGORIES[category];
  let quizzes;
  let roundToken = null;
  try {
    if (mode === 'daily') ({ quizzes, round: roundToken } = await api.getRound(category));
    else if (quizId) quizzes = [(await api.getQuiz(quizId)).quiz];
    else ({ quizzes } = await api.getPractice(category));
  } catch (err) {
    if (err.status !== 404) throw err;
    view.innerHTML = `
      <section class="center-card card">
        <p class="big-emoji" aria-hidden="true">${c.emoji}</p>
        <h1 class="title-sm">${c.label} 문제를 준비 중이에요</h1>
        <a class="btn btn-dark" href="#/">다른 장르 고르기 ${ARROW}</a>
      </section>`;
    return;
  }

  const isDaily = mode === 'daily';
  const ids = quizzes.map((q) => q.id);
  const rec = {
    // deadline: 그림이 뜬 순간부터 TIME_LIMIT 초 뒤 (performance.now 기준)
    items: ids.map(() => ({ guesses: [], solved: false, done: false, timedOut: false, answer: null, deadline: null })),
    current: 0,
    done: false,
    submitted: null,
  };
  const hints = {};
  let busy = false;
  let nicknameError = '';

  const total = quizzes.length;
  const LIMIT_MS = TIME_LIMIT * 1000;
  const remainingOf = (item) => (item.deadline ? Math.max(0, item.deadline - performance.now()) : LIMIT_MS);

  // 다음 그림을 미리 받아둬서 문제가 바뀔 때 시간이 새지 않게 합니다.
  quizzes.forEach((q) => {
    new Image().src = q.image;
  });

  // 남은 시간 표시 · 시간 초과 처리
  const tick = () => {
    const item = rec.items[rec.current];
    if (rec.done || !item || item.done || !item.deadline) return;
    const left = remainingOf(item);
    const fill = view.querySelector('.timer-fill');
    const sec = view.querySelector('.timer-sec');
    if (fill) {
      fill.style.transform = `scaleX(${left / LIMIT_MS})`;
      fill.classList.toggle('is-low', left < 2000);
    }
    if (sec) sec.textContent = `${(left / 1000).toFixed(1)}초`;
    if (left <= 0 && !busy) timeUp();
  };
  const timer = setInterval(tick, 50);
  cleanup = () => clearInterval(timer);

  // ----- 한 문제 화면 -----
  const drawQuestion = () => {
    const i = rec.current;
    const quiz = quizzes[i];
    const item = rec.items[i];
    const wrong = item.guesses.length - (item.solved ? 1 : 0);
    const canHint = quiz.hasHint && !item.done && wrong >= HINT_AFTER && !hints[i];

    const tried = item.guesses
      .map((g, k) => {
        const hit = item.solved && k === item.guesses.length - 1;
        return `<li class="${hit ? 'hit' : 'miss'}">${esc(g)}</li>`;
      })
      .join('');

    const isLast = i === total - 1;
    const bottom = item.done
      ? `
        <div class="reveal ${item.solved ? 'is-hit' : 'is-miss'}">
          <span class="reveal-badge">${item.solved ? '정답! +1점' : item.timedOut ? '시간 초과' : '아쉬워요'}</span>
          <strong class="reveal-answer">${esc(item.answer)}</strong>
        </div>
        <button type="button" class="btn btn-dark btn-wide" data-action="next">${isLast ? '결과 보기' : '다음 문제'} ${ARROW}</button>`
      : `
        <div class="timer" role="timer" aria-label="남은 시간"><i class="timer-fill" style="transform: scaleX(${remainingOf(item) / LIMIT_MS})"></i></div>
        <form class="answer-bar" autocomplete="off">
          <label class="sr-only" for="guess">작품 제목</label>
          <input id="guess" name="guess" type="text" maxlength="60" placeholder="제목은?" enterkeyhint="send" />
          <button type="submit" class="btn btn-dark">정답 ${ARROW}</button>
        </form>
        <div class="stage-sub">
          <span class="timer-sec">${(remainingOf(item) / 1000).toFixed(1)}초</span>
          ${tried ? `<ul class="tried">${tried}</ul>` : ''}
          <span class="sub-actions">
            ${canHint ? '<button type="button" class="link" data-action="hint">힌트</button>' : ''}
            <button type="button" class="link" data-action="pass">패스</button>
          </span>
        </div>
        ${hints[i] ? `<p class="hint">💡 ${esc(hints[i])}</p>` : ''}`;

    view.innerHTML = `
      <div class="stage">
        <div class="stage-top">
          ${chip(category)}
          ${total > 1 ? `<span class="progress" aria-label="${total}문제 중 ${i + 1}번째">${rec.items.map((it, k) => `<i class="${k === i ? 'now' : it.done ? (it.solved ? 'hit' : 'miss') : ''}"></i>`).join('')}</span>` : ''}
        </div>
        ${frame(`<button type="button" class="frame-photo" data-zoom aria-label="크게 보기"><img src="${esc(quiz.image)}" alt="${c.label} 장면 문제" /></button>`, 'frame-stage')}
        ${bottom}
      </div>`;

    view.querySelector('[data-zoom]').addEventListener('click', () => openZoom(quiz.image, item.done ? item.answer : ''));

    // 그림이 뜨면 시간이 흐르기 시작해요. (다시 그려도 처음 정한 마감은 그대로)
    if (!item.done && !item.deadline) {
      const img = view.querySelector('.frame-photo img');
      const start = () => {
        item.deadline ??= performance.now() + LIMIT_MS;
      };
      if (img.complete) start();
      else {
        img.addEventListener('load', start, { once: true });
        img.addEventListener('error', start, { once: true });
      }
    }

    const form = view.querySelector('.answer-bar');
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = form.guess.value.trim();
      if (!value) {
        form.guess.focus();
        return;
      }
      if (item.guesses.some((g) => g && normalize(g) === normalize(value))) {
        toast('이미 입력한 답이에요');
        return;
      }
      guess(value);
    });
    view.querySelector('[data-action="pass"]')?.addEventListener('click', () => pass());
    view.querySelector('[data-action="hint"]')?.addEventListener('click', async () => {
      try {
        hints[i] = (await api.getHint(quiz.id)).hint;
        drawQuestion();
        view.querySelector('#guess')?.focus();
      } catch (err) {
        toast(err.message);
      }
    });
    view.querySelector('[data-action="next"]')?.addEventListener('click', () => {
      rec.current = i + 1;
      if (rec.current >= total) rec.done = true;
      draw();
    });

    if (item.done) view.querySelector('[data-action="next"]').focus();
    else view.querySelector('#guess').focus({ preventScroll: true });
  };

  const lock = () =>
    view.querySelectorAll('.answer-bar button, .answer-bar input, .stage-sub button').forEach((el) => {
      el.disabled = true;
    });

  const finishItem = async (item, quiz) => {
    item.done = true;
    item.answer ??= (await api.getAnswer(quiz.id)).answer;
  };

  const guess = async (value) => {
    const quiz = quizzes[rec.current];
    const item = rec.items[rec.current];
    if (busy || remainingOf(item) <= 0) return;
    busy = true;
    lock();
    try {
      const result = await api.sendGuess(quiz.id, value);
      item.guesses.push(value);
      if (result.correct) {
        item.solved = true;
        item.answer = result.answer;
        await finishItem(item, quiz);
      } else {
        toast('땡!', 'miss');
      }
    } catch (err) {
      toast(err.message);
    } finally {
      busy = false;
      drawQuestion();
    }
  };

  /** 이 문제는 넘어갑니다. */
  const pass = () => endItem(false);

  /** 시간이 다 됐어요. */
  const timeUp = () => endItem(true);

  const endItem = async (timedOut) => {
    if (busy) return;
    busy = true;
    lock();
    const quiz = quizzes[rec.current];
    const item = rec.items[rec.current];
    try {
      item.timedOut = timedOut;
      if (timedOut) toast('시간 초과!', 'miss');
      await finishItem(item, quiz);
    } catch (err) {
      toast(err.message);
    } finally {
      busy = false;
      drawQuestion();
    }
  };

  // ----- 한 판 결과 -----
  const submit = async () => {
    const player = getPlayer();
    if (!isDaily || rec.submitted || !player) return;
    try {
      const res = await api.submitResult({
        token: player.token,
        round: roundToken,
        category,
        items: rec.items.map((it, i) => ({ quizId: ids[i], guesses: it.guesses })),
      });
      rec.submitted = { rank: res.rank, participants: res.participants };
    } catch (err) {
      if (err.status === 401) setPlayer(null);
      else if (err.status === 409) rec.submitted = { rank: null, participants: 0, error: err.message };
      nicknameError = err.status === 401 ? '닉네임을 다시 등록해주세요.' : err.message;
    }
    drawSummary();
  };

  const rankBox = () => {
    if (!isDaily) return '';
    const player = getPlayer();
    if (rec.submitted?.error) return `<div class="rank-box"><p>${esc(rec.submitted.error)}</p></div>`;
    if (rec.submitted) {
      return `
        <a class="rank-box is-done" href="#/ranking?c=${category}">
          <span>${esc(player?.nickname ?? '')} · ${c.label} 랭킹</span>
          <strong>${rec.submitted.rank ? `${rec.submitted.rank}위` : '-'}<small> / ${rec.submitted.participants}명</small></strong>
        </a>`;
    }
    if (player) return '<div class="rank-box"><p>랭킹에 올리는 중…</p></div>';
    return `
      <form class="rank-box nick-form" autocomplete="off">
        <div class="nick-head">
          <span class="nick-emoji" aria-hidden="true">🏆</span>
          <div>
            <label for="nickname">닉네임 등록하고 랭킹에 올리기</label>
            <p class="nick-sub">이번 판 ${summarize(rec.items).points}점을 ${c.label} 랭킹에 올려보세요!</p>
          </div>
        </div>
        <div class="nick-row">
          <input id="nickname" name="nickname" class="input" type="text" minlength="2" maxlength="12" placeholder="닉네임 (2~12자)" />
          <button type="submit" class="btn btn-dark">등록</button>
        </div>
        ${nicknameError ? `<p class="form-error">${esc(nicknameError)}</p>` : ''}
      </form>`;
  };

  /** 못 맞힌 문제에서 마지막으로 낸 답 (낸 답이 없으면 '시간 초과' 또는 '패스') */
  const myAnswerOf = (item) => {
    const last = item.guesses.at(-1);
    if (last) return `<s>${esc(last)}</s>`;
    return item.timedOut ? '시간 초과' : '패스';
  };

  const drawSummary = () => {
    const s = summarize(rec.items);
    const scenes = quizzes
      .map((q, i) => {
        const item = rec.items[i];
        return `
        <li class="scene">
          <button type="button" class="scene-photo" data-scene="${i}" aria-label="${esc(item.answer)} 크게 보기">
            <img src="${esc(q.image)}" alt="" loading="lazy" />
            ${itemMark(item)}
          </button>
          <span class="scene-answer"><small class="scene-label">정답</small>${esc(item.answer)}</span>
          ${item.solved ? '' : `<span class="scene-mine"><small class="scene-label">내 답</small>${myAnswerOf(item)}</span>`}
        </li>`;
      })
      .join('');

    view.innerHTML = `
      <div class="stage stage-summary">
        <div class="stage-top">${chip(category)}${isDaily ? '' : '<span class="stage-tag">연습</span>'}</div>
        <h1 class="score"><mark>${s.correct}</mark> / ${s.total}</h1>
        ${rankBox()}
        <ul class="scene-grid">${scenes}</ul>
        <div class="summary-actions">
          <button type="button" class="btn btn-dark" data-action="retry">다시 풀기</button>
          <a class="btn btn-line" href="#/">홈으로</a>
        </div>
        <p class="footnote"><a href="#/ranking?c=${category}">랭킹 보기</a></p>
      </div>`;

    // 다시 풀기: 새로 랜덤으로 뽑은 판을 풉니다.
    view.querySelector('[data-action="retry"]').addEventListener('click', () => router());

    view.querySelectorAll('[data-scene]').forEach((b) =>
      b.addEventListener('click', () => {
        const i = Number(b.dataset.scene);
        openZoom(quizzes[i].image, rec.items[i].answer);
      }),
    );

    const nickForm = view.querySelector('.nick-form');
    nickForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nickname = nickForm.nickname.value.trim();
      if (!NICKNAME_RULE.test(nickname)) {
        nicknameError = '닉네임은 2~12자 한글·영문·숫자로 지어주세요.';
        drawSummary();
        return;
      }
      const btn = nickForm.querySelector('button');
      btn.disabled = true;
      try {
        setPlayer(await api.createPlayer(nickname));
        nicknameError = '';
        toast(`${nickname}님, 반가워요!`);
        await submit();
      } catch (err) {
        nicknameError = err.message;
        drawSummary();
        view.querySelector('#nickname')?.focus();
      }
    });
  };

  const draw = () => {
    if (rec.done) {
      drawSummary();
      if (isDaily && !rec.submitted && getPlayer()) submit();
    } else drawQuestion();
  };

  draw();
}

// =====================================================================
// 랭킹
// =====================================================================
async function renderRanking() {
  const q = queryOf();
  const category = CATEGORIES[q.get('c')] ? q.get('c') : 'movie';
  const player = getPlayer();
  const { rankings } = await api.getRankings(50, player?.token);
  const data = rankings[category];
  const meOutside = data.me && !data.top.some((r) => r.nickname === data.me.nickname);

  const tabs = Object.entries(CATEGORIES)
    .map(
      ([key, c]) =>
        `<a class="filter ${key === category ? 'active' : ''}" href="#/ranking?c=${key}">${c.emoji} ${c.label}</a>`,
    )
    .join('');

  view.innerHTML = `
    <div class="page">
      <a class="back-link" href="#/">← 홈</a>
      <div class="page-head">
        <h1 class="title">${CATEGORIES[category].label} <mark>랭킹</mark></h1>
      </div>
      <p class="lead">누적 점수 · ${data.participants}명</p>
      <nav class="filters" aria-label="장르">${tabs}</nav>
      <div class="card rank-card">
        ${rankList(data.top, player?.nickname, '아직 기록이 없어요')}
        ${meOutside ? `<div class="rank-me">${rankList([data.me], player.nickname, '')}</div>` : ''}
      </div>
      <p class="footnote">맞힌 문제마다 1점${player ? ` · 내 닉네임 ${esc(player.nickname)}` : ''}</p>
    </div>`;
}

// =====================================================================
// 지난 장면 둘러보기
// =====================================================================
async function renderGallery(category) {
  const c = CATEGORIES[category];
  const { rounds } = await api.getGallery(category);

  const scenesHtml = (scenes) =>
    `<ul class="scene-grid">${scenes
      .map(
        (s) => `
        <li class="scene">
          <button type="button" class="scene-photo" data-src="${esc(s.image)}" data-answer="${esc(s.answer)}" aria-label="${esc(s.answer)} 크게 보기">
            <img src="${esc(s.image)}" alt="" loading="lazy" />
          </button>
          <span class="scene-answer">${esc(s.answer)}</span>
        </li>`,
      )
      .join('')}</ul>`;

  const tabs = Object.entries(CATEGORIES)
    .map(([key, cc]) => `<a class="filter ${key === category ? 'active' : ''}" href="#/gallery/${key}">${cc.emoji} ${cc.label}</a>`)
    .join('');

  const todayBlock = `
    <section class="day-group">
      <h2 class="day-title">오늘</h2>
      <a class="card locked-today" href="#/play/${category}">
        <span>오늘 장면은 내일 공개돼요</span>${ARROW}
      </a>
    </section>`;

  view.innerHTML = `
    <div class="page">
      <a class="back-link" href="#/">← 홈</a>
      <h1 class="title">지난 <mark>${c.label}</mark> 장면</h1>
      <nav class="filters" aria-label="장르">${tabs}</nav>
      ${todayBlock}
      ${rounds
        .map(
          (r) => `<section class="day-group"><h2 class="day-title">${formatDay(r.day)}</h2>${scenesHtml(r.scenes)}</section>`,
        )
        .join('')}
      ${rounds.length ? '' : '<p class="rank-empty">지난 장면은 내일부터 쌓여요</p>'}
    </div>`;

  view.querySelectorAll('[data-src]').forEach((b) =>
    b.addEventListener('click', () => openZoom(b.dataset.src, b.dataset.answer)),
  );
}

// =====================================================================
// 관리자
// =====================================================================
function renderAdminLogin(message) {
  view.innerHTML = `
    <section class="center-card card">
      <p class="big-emoji" aria-hidden="true">🔐</p>
      <h1 class="title-sm">관리자 로그인</h1>
      <p class="lead">문제를 등록하고 관리하려면 비밀번호를 입력해주세요.</p>
      ${message ? `<p class="form-error">${esc(message)}</p>` : ''}
      <form class="login-form">
        <label class="sr-only" for="password">관리자 비밀번호</label>
        <input id="password" name="password" type="password" class="input" placeholder="관리자 비밀번호" autocomplete="current-password" required />
        <button type="submit" class="btn btn-dark btn-block">들어가기 ${ARROW}</button>
      </form>
      <a class="footnote" href="#/">퀴즈로 돌아가기</a>
    </section>`;

  const form = view.querySelector('.login-form');
  form.password.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api.adminLogin(form.password.value);
      toast('어서오세요, 관리자님!');
      router();
    } catch (err) {
      btn.disabled = false;
      toast(err.status === 401 ? '비밀번호가 맞지 않아요' : err.message);
      form.password.select();
    }
  });
}

async function renderAdminList() {
  const filter = CATEGORIES[queryOf().get('c')] ? queryOf().get('c') : 'all';
  const [{ quizzes }, settings, { counts: rankingCounts }] = await Promise.all([
    api.adminList(),
    api.adminGetSettings(),
    api.adminRankingCounts(),
  ]);
  const list = filter === 'all' ? quizzes : quizzes.filter((q) => q.category === filter);
  const countOf = (key) => (key === 'all' ? quizzes.length : quizzes.filter((q) => q.category === key).length);
  const sizes = { ...settings.roundSize };

  const settingRows = () =>
    Object.entries(CATEGORIES)
      .map(([key, c]) => {
        const n = sizes[key];
        const count = countOf(key);
        return `
        <div class="setting-row">
          <span class="setting-label">${c.emoji} ${c.label}</span>
          <div class="stepper" role="group" aria-label="${c.label} 한 판 문제 수">
            <button type="button" data-step="-1" data-key="${key}" aria-label="줄이기" ${n <= 1 ? 'disabled' : ''}>−</button>
            <output>${n}</output>
            <button type="button" data-step="1" data-key="${key}" aria-label="늘리기" ${n >= settings.max ? 'disabled' : ''}>+</button>
          </div>
          <span class="setting-note ${count < n ? 'warn' : ''}">${
            !count ? '등록된 문제가 없어요' : count < n ? `문제가 ${count}개뿐이라 ${count}문제만 나가요` : `등록 ${count}개`
          }</span>
        </div>`;
      })
      .join('');

  const resetRows = Object.entries(CATEGORIES)
    .map(([key, c]) => {
      const n = rankingCounts[key];
      return `
        <div class="setting-row">
          <span class="setting-label">${c.emoji} ${c.label}</span>
          <button type="button" class="btn btn-line btn-sm btn-reset" data-reset="${key}" ${n ? '' : 'disabled'}>초기화</button>
          <span class="setting-note">${n ? `${n}명 기록` : '기록이 없어요'}</span>
        </div>`;
    })
    .join('');

  const filters = [['all', '전체'], ...Object.entries(CATEGORIES).map(([k, c]) => [k, `${c.emoji} ${c.label}`])]
    .map(
      ([key, label]) =>
        `<a class="filter ${key === filter ? 'active' : ''}" href="#/admin${key === 'all' ? '' : `?c=${key}`}">${label}<small>${countOf(key)}</small></a>`,
    )
    .join('');

  const items = list
    .map(
      (q) => `
      <li class="card quiz-card">
        <a class="quiz-thumb" href="#/practice/${q.category}/${q.id}" aria-label="${esc(q.answer)} 풀어보기">
          <img src="${esc(q.image)}" alt="" loading="lazy" />
        </a>
        <div class="quiz-info">
          <div class="quiz-head">
            <span class="tag">${CATEGORIES[q.category].emoji} ${CATEGORIES[q.category].label}</span>
            <time>${new Date(q.createdAt).toLocaleDateString('ko-KR')}</time>
          </div>
          <p class="quiz-answer">${esc(q.answer)}</p>
          ${q.aliases?.length ? `<p class="quiz-meta">또는 ${q.aliases.map(esc).join(', ')}</p>` : ''}
          ${q.hint ? `<p class="quiz-meta">💡 ${esc(q.hint)}</p>` : ''}
          <div class="quiz-actions">
            <a class="btn btn-line btn-sm" href="#/practice/${q.category}/${q.id}">풀어보기</a>
            <button type="button" class="btn btn-ghost btn-sm" data-delete="${q.id}">삭제</button>
          </div>
        </div>
      </li>`,
    )
    .join('');

  view.innerHTML = `
    <div class="page page-wide">
      <div class="page-head">
        <div>
          <h1 class="title">문제 <mark>관리</mark></h1>
          <p class="lead">등록한 문제는 모든 사용자에게 오늘의 판으로 출제돼요.</p>
        </div>
        <a class="btn btn-dark" href="#/admin/new${filter === 'all' ? '' : `?category=${filter}`}">+ 새 문제 등록</a>
      </div>

      <section class="card settings-card">
        <div class="settings-head">
          <h2 class="title-xs">한 판 문제 수</h2>
          <p>사용자가 한 번 플레이할 때 푸는 문제 수예요. 저장하면 다음 판부터 바로 적용되고, 등록된 문제가 적으면 있는 만큼만 나가요.</p>
        </div>
        <div class="settings-rows">${settingRows()}</div>
        <button type="button" class="btn btn-dark btn-sm" data-action="save-settings" disabled>저장</button>
      </section>

      <section class="card settings-card">
        <div class="settings-head">
          <h2 class="title-xs">랭킹 초기화</h2>
          <p>장르의 누적 랭킹 기록을 모두 지워요. 문제와 닉네임은 그대로예요.</p>
        </div>
        <div class="settings-rows">${resetRows}</div>
      </section>

      <nav class="filters" aria-label="카테고리 필터">${filters}</nav>
      ${
        list.length
          ? `<ul class="quiz-grid">${items}</ul>`
          : `<section class="center-card card">
               <p class="big-emoji" aria-hidden="true">🖼️</p>
               <h2 class="title-sm">아직 등록한 문제가 없어요</h2>
               <a class="btn btn-dark" href="#/admin/new${filter === 'all' ? '' : `?category=${filter}`}">문제 등록하기 ${ARROW}</a>
             </section>`
      }
    </div>
  `;

  // 한 판 문제 수
  const rowsEl = view.querySelector('.settings-rows');
  const saveBtn = view.querySelector('[data-action="save-settings"]');
  const bindSteppers = () =>
    rowsEl.querySelectorAll('[data-step]').forEach((b) =>
      b.addEventListener('click', () => {
        const key = b.dataset.key;
        sizes[key] = Math.min(settings.max, Math.max(1, sizes[key] + Number(b.dataset.step)));
        rowsEl.innerHTML = settingRows();
        bindSteppers();
        saveBtn.disabled = Object.keys(sizes).every((k) => sizes[k] === settings.roundSize[k]);
      }),
    );
  bindSteppers();
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const saved = await api.adminSaveSettings(sizes);
      settings.roundSize = { ...saved.roundSize };
      toast('한 판 문제 수를 저장했어요');
    } catch (err) {
      saveBtn.disabled = false;
      toast(err.message);
    }
  });

  // 랭킹 초기화
  view.querySelectorAll('[data-reset]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const key = btn.dataset.reset;
      const { label } = CATEGORIES[key];
      if (!confirm(`${label} 랭킹을 초기화할까요?\n${rankingCounts[key]}명의 기록이 모두 지워지고 되돌릴 수 없어요.`)) return;
      btn.disabled = true;
      try {
        await api.adminResetRanking(key);
        toast(`${label} 랭킹을 초기화했어요`);
        router({ keepScroll: true });
      } catch (err) {
        btn.disabled = false;
        if (err.status === 401) router();
        else toast(err.message);
      }
    }),
  );

  view.querySelectorAll('[data-delete]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const quiz = quizzes.find((q) => q.id === btn.dataset.delete);
      if (!confirm(`'${quiz.answer}' 문제를 삭제할까요?\n삭제하면 되돌릴 수 없어요.`)) return;
      btn.disabled = true;
      try {
        await api.adminDelete(quiz.id);
        toast('삭제했어요');
        router({ keepScroll: true });
      } catch (err) {
        btn.disabled = false;
        if (err.status === 401) router();
        else toast(err.message);
      }
    }),
  );
}

async function renderAdminNew() {
  const preset = queryOf().get('category');
  let picked = null; // { img, url }

  view.innerHTML = `
    <form class="split upload-form" novalidate>
      ${frame(`
        <label class="dropzone" tabindex="0">
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden />
          <span class="dropzone-icon" aria-hidden="true">＋</span>
          <span class="dropzone-text">장면 그림 한 장</span>
          <span class="dropzone-sub">클릭하거나 여기로 끌어다 놓으세요</span>
        </label>
        <div class="frame-photo preview" hidden></div>`)}
      <section class="side">
        <a class="back-link" href="#/admin">← 문제 관리</a>
        <h1 class="title">새 한 컷 문제<br /><mark>등록</mark>하기</h1>
        <p class="lead">그림 한 장, 카테고리, 정답만 있으면 돼요.</p>

        <div class="card form-card">
          <fieldset class="field">
            <legend class="field-label">카테고리</legend>
            <div class="seg-group">
              ${Object.entries(CATEGORIES)
                .map(
                  ([key, c]) => `
                <label class="seg">
                  <input type="radio" name="category" value="${key}" ${key === (CATEGORIES[preset] ? preset : 'movie') ? 'checked' : ''} />
                  <span>${c.emoji} ${c.label}</span>
                </label>`,
                )
                .join('')}
            </div>
          </fieldset>
          <div class="field">
            <label class="field-label" for="answer">정답</label>
            <input id="answer" name="answer" class="input-line" type="text" placeholder="예) 기생충" maxlength="60" required />
          </div>
          <div class="field">
            <label class="field-label" for="aliases">다른 정답 <small>선택 · 쉼표로 구분</small></label>
            <input id="aliases" name="aliases" class="input-line" type="text" placeholder="예) parasite, 패러사이트" />
          </div>
          <div class="field">
            <label class="field-label" for="hint">힌트 <small>선택 · ${HINT_AFTER}번 틀리면 공개</small></label>
            <input id="hint" name="hint" class="input-line" type="text" placeholder="예) 2019년 칸 영화제 황금종려상" maxlength="80" />
          </div>
          <p class="card-foot"><span>띄어쓰기·대소문자·특수문자는 자동으로 무시하고 채점해요</span></p>
        </div>
        <button type="submit" class="btn btn-dark btn-block">문제 등록하기 ${ARROW}</button>
      </section>
    </form>
  `;

  const formEl = view.querySelector('.upload-form');
  const fileInput = formEl.querySelector('input[type="file"]');
  const dropzone = formEl.querySelector('.dropzone');
  const preview = formEl.querySelector('.preview');

  const clear = () => {
    if (picked) URL.revokeObjectURL(picked.url);
    picked = null;
  };
  cleanup = clear;

  const drawPreview = () => {
    dropzone.hidden = Boolean(picked);
    preview.hidden = !picked;
    if (!picked) {
      preview.innerHTML = '';
      return;
    }
    preview.innerHTML = `
      <img src="${picked.url}" alt="올린 그림 미리보기" />
      <button type="button" class="photo-reset" data-action="reset">사진 바꾸기</button>`;
    preview.querySelector('[data-action="reset"]').addEventListener('click', () => {
      clear();
      fileInput.value = '';
      drawPreview();
      fileInput.click();
    });
  };

  const handleFiles = async (fileList) => {
    const files = [...fileList].filter((f) => f.type.startsWith('image/'));
    if (!files.length) {
      toast('이미지 파일을 올려주세요');
      return;
    }
    if (files.length > 1) toast('첫 번째 사진만 사용할게요');
    try {
      clear();
      picked = await loadImage(files[0]);
      drawPreview();
    } catch (err) {
      toast(err.message);
    }
  };

  fileInput.addEventListener('change', () => handleFiles(fileInput.files));
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  ['dragenter', 'dragover'].forEach((t) =>
    dropzone.addEventListener(t, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragging');
    }),
  );
  ['dragleave', 'drop'].forEach((t) => dropzone.addEventListener(t, () => dropzone.classList.remove('dragging')));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  });

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const answer = formEl.answer.value.trim();
    if (!picked) {
      toast('문제 그림을 먼저 올려주세요');
      return;
    }
    if (!answer) {
      toast('정답을 입력해주세요');
      formEl.answer.focus();
      return;
    }

    const submitBtn = formEl.querySelector('[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = '올리는 중…';
    try {
      const category = formEl.category.value;
      const { img } = picked;
      await api.adminCreate({
        category,
        answer,
        aliases: formEl.aliases.value.split(',').map((s) => s.trim()).filter(Boolean),
        hint: formEl.hint.value.trim(),
        image: compressImage(img),
        aspect: +(img.naturalWidth / img.naturalHeight).toFixed(4),
      });
      toast(`${CATEGORIES[category].label} 문제를 등록했어요!`);
      location.hash = `#/admin?c=${category}`;
    } catch (err) {
      console.error(err);
      if (err.status === 401) {
        router();
        return;
      }
      toast(err.message || '등록에 실패했어요');
      submitBtn.disabled = false;
      submitBtn.innerHTML = `문제 등록하기 ${ARROW}`;
    }
  });
}
