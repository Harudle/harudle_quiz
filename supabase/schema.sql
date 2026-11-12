-- 하루들 한컷퀴즈 스키마 — Supabase 대시보드 SQL Editor 에서 한 번 실행하세요.
-- 여러 번 실행해도 괜찮아요.

create table if not exists quizzes (
  id text primary key,
  category text not null,
  answer text not null,
  aliases text[] not null default '{}',
  hint text not null default '',
  image text not null,                    -- Storage 버킷 안의 경로 (quizzes/<id>.jpg)
  aspect double precision not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists quizzes_category_idx on quizzes (category, created_at desc);

-- 그날 장르별로 출제된 한 판 (하루 동안 고정)
create table if not exists daily_rounds (
  day text not null,                      -- 한국 시간 YYYY-MM-DD
  category text not null,
  quiz_ids text[] not null,
  primary key (day, category)
);

-- 장르별 한 판 문제 수
create table if not exists settings (
  category text primary key,
  round_size int not null
);

-- 닉네임은 장르마다 따로예요. (같은 닉네임을 다른 장르에서 또 쓸 수 있어요)
create table if not exists players (
  id text primary key,
  category text,
  nickname text not null,
  nickname_norm text not null,            -- 띄어쓰기·대소문자를 무시한 중복 검사용
  token_hash text not null unique,
  created_at timestamptz not null default now()
);
create unique index if not exists players_category_nickname_idx on players (category, nickname_norm);

-- 오늘의 한 판 결과 (플레이어·날짜·장르마다 한 번)
create table if not exists results (
  player_id text not null references players (id) on delete cascade,
  day text not null,
  category text not null,
  points int not null,
  correct int not null,
  total int not null,
  at timestamptz not null default now(),
  primary key (player_id, day, category)
);
create index if not exists results_category_day_idx on results (category, day);

-- 브라우저는 Supabase 에 직접 붙지 않고 서버(Vercel 함수)만 DB 에 접근해요.
-- RLS 를 켜고 정책을 두지 않아서 anon 키로는 정답을 포함해 아무것도 읽을 수 없어요.
alter table quizzes enable row level security;
alter table daily_rounds enable row level security;
alter table settings enable row level security;
alter table players enable row level security;
alter table results enable row level security;

-- 문제 그림 버킷 (누구나 읽기, 쓰기는 서버만)
insert into storage.buckets (id, name, public)
values ('quiz-images', 'quiz-images', true)
on conflict (id) do nothing;
