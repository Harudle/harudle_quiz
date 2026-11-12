// Vercel 함수 — /api/* 요청은 vercel.json 의 rewrite 로 모두 여기로 들어옵니다.
import { handleApiRequest } from '../lib/routes.js';

export default handleApiRequest;
