import * as api from './api.js';
import { compressImage, loadImage } from './image.js';
import { CATEGORIES, HINT_AFTER, MAX_TRIES, NICKNAME_RULE, normalize, pointsFor } from './shared.js';
import {
  getPlayer,
  getRoundRecord,
  getStats,
  itemEmoji,
  roundEmoji,
  sameIds,
  saveRoundRecord,
  setPlayer,
  summarize,
} from './game.js';

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
function toast(message) {
  toastEl.textContent = message;
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

const periodToggle = (period) => `
  <div class="toggle" role="group" aria-label="기간">
    <button type="button" data-period="today" aria-pressed="${period === 'today'}">오늘</button>
    <button type="button" data-period="all" aria-pressed="${period === 'all'}">전체</button>
  </div>`;

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

async function router() {
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
  window.scrollTo(0, 0);

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

window.addEventListener('hashchange', router);
router();

// =====================================================================
// 홈
// =====================================================================
async function renderHome() {
  const { day, categories } = await api.getCategories();
  const stats = getStats();
  const firstAvailable = categories.find((c) => c.count)?.key;
  let selected = firstAvailable ?? 'movie';

  /** 오늘 정해진 판과 같은 판의 기록만 인정합니다. (중간에 문제가 바뀐 경우 무시) */
  const recordOf = (key) => {
    const record = getRoundRecord(key, day);
    const { dailyIds } = categories.find((c) => c.key === key);
    return record && sameIds(record.quizIds, dailyIds) ? record : null;
  };

  const statusOf = (key, count) => {
    const record = recordOf(key);
    if (!count) return '<span class="status status-empty">준비 중</span>';
    if (record?.done) {
      const s = summarize(record.items);
      return `<span class="status status-solved">${s.correct}/${s.total} 맞힘</span>`;
    }
    if (record?.items?.some((it) => it.done)) return '<span class="status status-progress">푸는 중</span>';
    return '<span class="status status-new">NEW</span>';
  };

  const options = categories
    .map(({ key, count, roundSize }) => {
      const c = CATEGORIES[key];
      return `
        <label class="option ${count ? '' : 'is-disabled'}">
          <input type="radio" name="category" value="${key}" ${key === selected ? 'checked' : ''} ${count ? '' : 'disabled'} />
          <span class="option-emoji" aria-hidden="true">${c.emoji}</span>
          <span class="option-body">
            <span class="option-title">${c.label}</span>
            <span class="option-desc">${count ? `한 판 ${roundSize}문제` : c.desc}</span>
          </span>
          ${statusOf(key, count)}
        </label>`;
    })
    .join('');

  view.innerHTML = `
    <div class="split">
      ${frame(`
        <div class="teaser" aria-hidden="true">
          <span class="teaser-text">이 장면… 어디서 봤더라?</span>
          <span class="teaser-q">?</span>
          <span class="teaser-icons"><i>🎬</i><i>📺</i><i>🍥</i></span>
        </div>`)}
      <section class="side">
        <h1 class="title">그림 한 컷 보고<br /><mark>제목</mark>을 맞혀볼까요?</h1>
        <p class="lead">${formatDay(day)} · 문제마다 기회는 ${MAX_TRIES}번!</p>

        <form class="card home-card">
          <div class="card-top">
            <p class="card-q">오늘은 어떤 장르?</p>
            <div class="stamp" aria-label="내 기록">
              <span class="stamp-title">MY</span>
              <strong>${stats.correct}<small>/${stats.total}</small></strong>
              <span class="stamp-sub">맞힌 문제</span>
            </div>
          </div>
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
        ${periodToggle('today')}
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
    label.textContent = recordOf(selected)?.done
      ? `오늘의 ${CATEGORIES[selected].label} 결과 보기`
      : `오늘의 ${CATEGORIES[selected].label} 풀기`;
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
  const loadBoard = async (period) => {
    view.querySelectorAll('.board [data-period]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.period === period)));
    try {
      const { rankings } = await api.getRankings(period, 5, player?.token);
      board.innerHTML = Object.entries(CATEGORIES)
        .map(
          ([key, c]) => `
          <div class="card board-card">
            <p class="board-title">${c.emoji} ${c.label}</p>
            ${rankList(rankings[key].top, player?.nickname, period === 'today' ? '오늘 첫 번째 주인공이 되어보세요' : '아직 기록이 없어요')}
            <a class="board-more" href="#/ranking?c=${key}&p=${period}">전체 순위 ${ARROW}</a>
          </div>`,
        )
        .join('');
    } catch (err) {
      board.innerHTML = `<p class="rank-empty">${esc(err.message)}</p>`;
    }
  };
  view.querySelectorAll('.board [data-period]').forEach((b) => b.addEventListener('click', () => loadBoard(b.dataset.period)));
  loadBoard('today');
}

// =====================================================================
// 퀴즈 한 판
// =====================================================================
async function renderPlay(category, mode, quizId) {
  const c = CATEGORIES[category];
  let quizzes;
  let day = null;
  try {
    if (mode === 'daily') ({ day, quizzes } = await api.getDaily(category));
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
  const saved = isDaily ? getRoundRecord(category, day) : null;
  const rec =
    saved && sameIds(saved.quizIds, ids)
      ? saved
      : {
          quizIds: ids,
          items: ids.map(() => ({ guesses: [], solved: false, done: false, answer: null })),
          current: 0,
          done: false,
          submitted: null,
        };
  const hints = {};
  let busy = false;
  let nicknameError = '';

  const persist = () => {
    if (isDaily) saveRoundRecord(category, day, rec);
  };

  // 끝난 문제인데 정답이 없으면 받아옵니다.
  await Promise.all(
    rec.items.map(async (it, i) => {
      if (it.done && !it.answer) it.answer = (await api.getAnswer(ids[i])).answer;
    }),
  );

  const total = quizzes.length;

  // ----- 한 문제 화면 -----
  const drawQuestion = () => {
    const i = rec.current;
    const quiz = quizzes[i];
    const item = rec.items[i];
    const left = MAX_TRIES - item.guesses.length;
    const wrong = item.guesses.length - (item.solved ? 1 : 0);
    const canHint = quiz.hasHint && !item.done && wrong >= HINT_AFTER && !hints[i];

    const tried = item.guesses
      .map((g, k) => {
        const hit = item.solved && k === item.guesses.length - 1;
        return `<li class="${hit ? 'hit' : 'miss'}">${g ? esc(g) : '패스'}</li>`;
      })
      .join('');

    const dots = Array.from({ length: MAX_TRIES }, (_, k) => {
      let cls = 'dot';
      if (k < item.guesses.length) cls += item.solved && k === item.guesses.length - 1 ? ' hit' : ' miss';
      return `<i class="${cls}"></i>`;
    }).join('');

    const isLast = i === total - 1;
    const bottom = item.done
      ? `
        <div class="reveal ${item.solved ? 'is-hit' : 'is-miss'}">
          <span class="reveal-badge">${item.solved ? `정답! +${pointsFor(item.guesses.length, true)}점` : '아쉬워요'}</span>
          <strong class="reveal-answer">${esc(item.answer)}</strong>
        </div>
        <button type="button" class="btn btn-dark btn-wide" data-action="next">${isLast ? '결과 보기' : '다음 문제'} ${ARROW}</button>`
      : `
        <form class="answer-bar" autocomplete="off">
          <label class="sr-only" for="guess">작품 제목</label>
          <input id="guess" name="guess" type="text" maxlength="60" placeholder="제목은?" enterkeyhint="send" />
          <button type="submit" class="btn btn-dark">정답 ${ARROW}</button>
        </form>
        <div class="stage-sub">
          <span class="dots" aria-label="남은 기회 ${left}번">${dots}</span>
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
      persist();
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
    if (busy) return;
    busy = true;
    lock();
    const quiz = quizzes[rec.current];
    const item = rec.items[rec.current];
    try {
      const result = await api.sendGuess(quiz.id, value);
      item.guesses.push(value);
      if (result.correct) {
        item.solved = true;
        item.answer = result.answer;
        await finishItem(item, quiz);
      } else if (item.guesses.length >= MAX_TRIES) {
        await finishItem(item, quiz);
      } else {
        toast(MAX_TRIES - item.guesses.length === 1 ? '땡! 마지막 기회' : '땡!');
      }
      persist();
    } catch (err) {
      toast(err.message);
    } finally {
      busy = false;
      drawQuestion();
    }
  };

  /** 이 문제는 넘어갑니다. (남은 기회를 모두 패스로 채움) */
  const pass = async () => {
    if (busy) return;
    busy = true;
    lock();
    const quiz = quizzes[rec.current];
    const item = rec.items[rec.current];
    try {
      while (item.guesses.length < MAX_TRIES) item.guesses.push('');
      await finishItem(item, quiz);
      persist();
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
        day,
        category,
        items: rec.items.map((it, i) => ({ quizId: ids[i], guesses: it.guesses })),
      });
      rec.submitted = { rank: res.rank, participants: res.participants };
      persist();
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
        <a class="rank-box is-done" href="#/ranking?c=${category}&p=today">
          <span>${esc(player?.nickname ?? '')} · 오늘 ${c.label} 랭킹</span>
          <strong>${rec.submitted.rank ? `${rec.submitted.rank}위` : '-'}<small> / ${rec.submitted.participants}명</small></strong>
        </a>`;
    }
    if (player) return '<div class="rank-box"><p>랭킹에 올리는 중…</p></div>';
    return `
      <form class="rank-box nick-form" autocomplete="off">
        <label for="nickname">닉네임 등록하고 랭킹에 올리기</label>
        <div class="nick-row">
          <input id="nickname" name="nickname" class="input" type="text" minlength="2" maxlength="12" placeholder="닉네임 (2~12자)" />
          <button type="submit" class="btn btn-dark">등록</button>
        </div>
        ${nicknameError ? `<p class="form-error">${esc(nicknameError)}</p>` : ''}
      </form>`;
  };

  const drawSummary = () => {
    const s = summarize(rec.items);
    const scenes = quizzes
      .map(
        (q, i) => `
        <li class="scene">
          <button type="button" class="scene-photo" data-scene="${i}" aria-label="${esc(rec.items[i].answer)} 크게 보기">
            <img src="${esc(q.image)}" alt="" loading="lazy" />
            <span class="scene-mark">${itemEmoji(rec.items[i])}</span>
          </button>
          <span class="scene-answer">${esc(rec.items[i].answer)}</span>
        </li>`,
      )
      .join('');

    view.innerHTML = `
      <div class="stage stage-summary">
        <div class="stage-top">${chip(category)}<span class="stage-tag">${isDaily ? '오늘의 판' : '연습'}</span></div>
        <h1 class="score"><mark>${s.correct}</mark> / ${s.total}</h1>
        <p class="score-sub">${s.points}점 · ${roundEmoji(rec.items)}</p>
        ${rankBox()}
        <ul class="scene-grid">${scenes}</ul>
        <div class="btn-row">
          <button type="button" class="btn btn-line" data-action="share">결과 복사</button>
          <a class="btn btn-line" href="#/gallery/${category}">지난 장면 보기</a>
        </div>
        <a class="btn btn-dark btn-wide" href="#/practice/${category}?t=${Date.now()}">연습 한 판 더 ${ARROW}</a>
        <p class="footnote"><a href="#/ranking?c=${category}">랭킹</a> · <a href="#/">다른 장르</a></p>
      </div>`;

    view.querySelectorAll('[data-scene]').forEach((b) =>
      b.addEventListener('click', () => {
        const i = Number(b.dataset.scene);
        openZoom(quizzes[i].image, rec.items[i].answer);
      }),
    );

    view.querySelector('[data-action="share"]').addEventListener('click', async () => {
      const text = [
        `하루들 한컷퀴즈 ${c.emoji} ${c.label}${isDaily ? ` ${formatDay(day, false)}` : ' (연습)'}`,
        `${roundEmoji(rec.items)} ${s.correct}/${s.total} · ${s.points}점`,
        location.origin,
      ].join('\n');
      try {
        await navigator.clipboard.writeText(text);
        toast('결과를 복사했어요!');
      } catch {
        toast('복사에 실패했어요');
      }
    });

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
  const period = q.get('p') === 'all' ? 'all' : 'today';
  const player = getPlayer();
  const { rankings, day } = await api.getRankings(period, 50, player?.token);
  const data = rankings[category];
  const meOutside = data.me && !data.top.some((r) => r.nickname === data.me.nickname);

  const tabs = Object.entries(CATEGORIES)
    .map(
      ([key, c]) =>
        `<a class="filter ${key === category ? 'active' : ''}" href="#/ranking?c=${key}&p=${period}">${c.emoji} ${c.label}</a>`,
    )
    .join('');

  view.innerHTML = `
    <div class="page">
      <a class="back-link" href="#/">← 홈</a>
      <div class="page-head">
        <h1 class="title">${CATEGORIES[category].label} <mark>랭킹</mark></h1>
        ${periodToggle(period)}
      </div>
      <p class="lead">${period === 'today' ? `${formatDay(day)} · ${data.participants}명 참여` : `누적 점수 · ${data.participants}명`}</p>
      <nav class="filters" aria-label="장르">${tabs}</nav>
      <div class="card rank-card">
        ${rankList(data.top, player?.nickname, period === 'today' ? '오늘은 아직 기록이 없어요' : '아직 기록이 없어요')}
        ${meOutside ? `<div class="rank-me">${rankList([data.me], player.nickname, '')}</div>` : ''}
      </div>
      <p class="footnote">한 번에 맞히면 3점, 두 번째 2점, 세 번째 1점${player ? ` · 내 닉네임 ${esc(player.nickname)}` : ''}</p>
    </div>`;

  view.querySelectorAll('[data-period]').forEach((b) =>
    b.addEventListener('click', () => {
      location.hash = `#/ranking?c=${category}&p=${b.dataset.period}`;
    }),
  );
}

// =====================================================================
// 지난 장면 둘러보기
// =====================================================================
async function renderGallery(category) {
  const c = CATEGORIES[category];
  const { day, rounds } = await api.getGallery(category);

  // 오늘 판은 다 푼 사람에게만 보여줍니다.
  let todayScenes = null;
  const record = getRoundRecord(category, day);
  if (record?.done) {
    try {
      const { quizzes } = await api.getDaily(category);
      if (sameIds(record.quizIds, quizzes.map((q) => q.id))) {
        todayScenes = quizzes.map((q, i) => ({ ...q, answer: record.items[i].answer, mark: itemEmoji(record.items[i]) }));
      }
    } catch {
      // 오늘 문제가 없으면 건너뜁니다.
    }
  }

  const scenesHtml = (scenes) =>
    `<ul class="scene-grid">${scenes
      .map(
        (s) => `
        <li class="scene">
          <button type="button" class="scene-photo" data-src="${esc(s.image)}" data-answer="${esc(s.answer)}" aria-label="${esc(s.answer)} 크게 보기">
            <img src="${esc(s.image)}" alt="" loading="lazy" />
            ${s.mark ? `<span class="scene-mark">${s.mark}</span>` : ''}
          </button>
          <span class="scene-answer">${esc(s.answer)}</span>
        </li>`,
      )
      .join('')}</ul>`;

  const tabs = Object.entries(CATEGORIES)
    .map(([key, cc]) => `<a class="filter ${key === category ? 'active' : ''}" href="#/gallery/${key}">${cc.emoji} ${cc.label}</a>`)
    .join('');

  const todayBlock = todayScenes
    ? `<section class="day-group"><h2 class="day-title">오늘</h2>${scenesHtml(todayScenes)}</section>`
    : `<section class="day-group">
         <h2 class="day-title">오늘</h2>
         <a class="card locked-today" href="#/play/${category}">
           <span>오늘 판을 다 풀면 볼 수 있어요</span>${ARROW}
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
  const [{ quizzes }, settings] = await Promise.all([api.adminList(), api.adminGetSettings()]);
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
          <p>사용자가 한 번 플레이할 때 푸는 문제 수예요. 오늘 이미 출제된 판은 그대로고, 다음 판부터 적용돼요.</p>
        </div>
        <div class="settings-rows">${settingRows()}</div>
        <button type="button" class="btn btn-dark btn-sm" data-action="save-settings" disabled>저장</button>
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

  view.querySelectorAll('[data-delete]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const quiz = quizzes.find((q) => q.id === btn.dataset.delete);
      if (!confirm(`'${quiz.answer}' 문제를 삭제할까요?\n삭제하면 되돌릴 수 없어요.`)) return;
      btn.disabled = true;
      try {
        await api.adminDelete(quiz.id);
        toast('삭제했어요');
        router();
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
