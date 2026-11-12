// 서버 API 호출 모음
const TOKEN_KEY = 'harudle-quiz:admin';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, admin = false, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (admin) headers.Authorization = `Bearer ${getAdminToken() ?? ''}`;
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, '서버에 연결할 수 없어요.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.message ?? '요청에 실패했어요.');
  return data;
}

const enc = encodeURIComponent;

// ---- 플레이어 ----
export const getCategories = () => request('/categories');
export const getRound = (category) => request(`/categories/${category}/round`);
export const getPractice = (category) => request(`/categories/${category}/practice`);
export const getGallery = (category) => request(`/categories/${category}/gallery`);
export const getQuiz = (id) => request(`/quizzes/${enc(id)}`);
export const sendGuess = (id, guess) => request(`/quizzes/${enc(id)}/guess`, { method: 'POST', body: { guess } });
export const getHint = (id) => request(`/quizzes/${enc(id)}/hint`, { method: 'POST', body: {} });
export const getAnswer = (id) => request(`/quizzes/${enc(id)}/answer`, { method: 'POST', body: {} });

export const createPlayer = (nickname) => request('/players', { method: 'POST', body: { nickname } });
export const submitResult = (payload) => request('/results', { method: 'POST', body: payload });
export const getRankings = (limit, playerToken) =>
  request(`/rankings?limit=${limit}`, {
    headers: playerToken ? { 'X-Player-Token': playerToken } : {},
  });

// ---- 관리자 ----
export function getAdminToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // 저장이 막혀 있으면 새로고침 시 다시 로그인하면 됩니다.
  }
}

export async function adminLogin(password) {
  setAdminToken(password);
  try {
    await request('/admin/login', { method: 'POST', body: {}, admin: true });
  } catch (err) {
    setAdminToken(null);
    throw err;
  }
}

export const adminList = () => request('/admin/quizzes', { admin: true });
export const adminCreate = (quiz) => request('/admin/quizzes', { method: 'POST', body: quiz, admin: true });
export const adminDelete = (id) => request(`/admin/quizzes/${enc(id)}`, { method: 'DELETE', admin: true });
export const adminRankingCounts = () => request('/admin/rankings', { admin: true });
export const adminResetRanking = (category) =>
  request(`/admin/rankings/${enc(category)}`, { method: 'DELETE', admin: true });
export const adminGetSettings = () => request('/admin/settings', { admin: true });
export const adminSaveSettings = (roundSize) =>
  request('/admin/settings', { method: 'PUT', body: { roundSize }, admin: true });
