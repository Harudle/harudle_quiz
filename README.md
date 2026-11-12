# 하루들 한컷퀴즈

장면 그림 한 컷을 보고 **영화 · 드라마 · 애니메이션** 제목을 맞히는 퀴즈 사이트예요.
하루들 엽서 화면처럼 민트 배경, 굵은 검정 테두리, 보라 형광펜 스타일로 만들었어요.

## 구성

- **Supabase** — Postgres(문제, 오늘의 한 판, 닉네임, 랭킹)와 Storage(문제 그림)
- **Vercel** — 정적 파일(`index.html`, `src/`)과 API 함수(`api/index.js`)

브라우저는 Supabase에 직접 붙지 않아요. 모든 요청은 `/api`를 거치고, DB 접속 정보는 서버 환경변수에만 있어요.

## 1. Supabase 준비

1. [supabase.com](https://supabase.com)에서 새 프로젝트를 만들어요. Region은 **Northeast Asia (Seoul)** 를 추천해요.
2. SQL Editor에서 `supabase/schema.sql` 내용을 붙여넣고 실행해요. 테이블과 `quiz-images` 버킷이 만들어져요.
3. 아래 값을 챙겨둬요.
   - **Connect → Transaction pooler** 연결 문자열 (6543 포트) → `DATABASE_URL`
   - **Project Settings → API**의 Project URL → `SUPABASE_URL`
   - Secret key (`sb_secret_...`, 예전 프로젝트는 `service_role`) → `SUPABASE_SECRET_KEY`

## 2. 로컬 실행

Node.js 20 이상이 필요해요.

```bash
npm install
cp .env.example .env   # 값 채우기
npm run dev
```

- 퀴즈: http://localhost:3000
- 관리자: http://localhost:3000/#/admin

로컬에서는 `ADMIN_PASSWORD`가 없으면 기본값 `harudle-admin`을 써요. Vercel에서는 기본값을 쓰지 않고 관리자 기능이 막혀요.

예전 버전에서 쓰던 `data/db.json`과 `data/uploads/`가 있다면 한 번 옮겨주세요. 여러 번 실행해도 중복되지 않아요.

```bash
npm run import-json
```

## 3. Vercel 배포

1. GitHub에 올린 뒤 Vercel에서 **Add New → Project**로 이 저장소를 가져와요. 설정은 `vercel.json`에 있어서 따로 건드릴 필요 없어요.
2. **Settings → Environment Variables**에 `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ADMIN_PASSWORD`를 넣어요.
3. 배포하면 끝이에요. API 함수는 서울 리전(`icn1`)에서 돌아가요.

무료 플랜 참고:
- Supabase 무료 프로젝트는 일주일 동안 요청이 없으면 일시정지돼요. 대시보드에서 다시 켤 수 있어요.
- Vercel 함수는 요청 본문이 4.5MB까지라서, 관리자 업로드 사진은 브라우저에서 그 안으로 줄여서 보내요.

## 게임 규칙

- 장르를 고르면 **오늘의 판**이 나와요. 한 판 문제 수는 관리자가 장르별로 정해요. (기본 5문제)
- 한국 시간 기준 하루 동안 모두에게 같은 판이 나와요.
- 문제마다 기회는 3번. 1번 틀리면 힌트를 볼 수 있어요. 모르면 패스.
- 점수: 첫 번째에 맞히면 3점, 두 번째 2점, 세 번째 1점.
- 다 풀면 닉네임을 등록해서 장르별 랭킹(오늘 / 전체)에 올라가요. 한 번 등록하면 다음부터는 자동으로 올라가요.
- 다 푼 뒤에는 오늘 장면과 지난 날짜에 나온 장면을 정답과 함께 둘러볼 수 있어요.
- 연습 한 판은 랭킹에 들어가지 않아요.

## 관리자

1. `#/admin`에서 관리자 비밀번호로 로그인
2. **새 문제 등록**: 그림 한 장 업로드 → 카테고리 선택 → 정답 입력
   - 다른 정답(영문 제목, 줄임말 등)과 힌트도 넣을 수 있어요.
   - 사진은 브라우저에서 적당한 크기의 JPEG로 줄인 뒤 올라가요.
3. 문제 관리에서 카테고리별로 보고, 미리 풀어보거나 삭제할 수 있어요.
4. **한 판 문제 수**: 장르별로 1~20문제. 오늘 이미 나간 판은 그대로고 다음 판부터 적용돼요.

## 폴더 구조

```
api/index.js         Vercel 함수 — /api/* 를 모두 받아 lib/routes.js 로 넘김
lib/routes.js        API (퀴즈, 랭킹, 관리자) — 로컬 서버와 Vercel 이 같이 씀
lib/store.js         Supabase 접근 (Postgres 쿼리, Storage 업로드)
server.js            로컬 개발 서버 (정적 파일 + API)
supabase/schema.sql  테이블·버킷 만들기
scripts/import-json.js  예전 data/ 를 Supabase 로 옮기기
src/shared.js        서버·브라우저 공용 (카테고리, 정답 비교, 날짜)
src/app.js           화면 (홈, 퀴즈, 관리자)
src/api.js           API 호출
src/game.js          결과 계산·표시, 닉네임 (브라우저에 저장하지 않음)
src/image.js         업로드 사진 압축
src/styles.css       스타일
```

정답은 서버에서 판정하고, 문제를 다 풀기 전에는 플레이어에게 정답을 보내지 않아요.
Supabase 테이블은 RLS를 켜고 정책을 두지 않아서, 공개 키로는 정답을 읽을 수 없어요.
