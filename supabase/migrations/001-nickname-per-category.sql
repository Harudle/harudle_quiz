-- 닉네임을 장르마다 따로 쓰도록 바꿉니다. (한 번만 실행하면 돼요. 다시 실행해도 괜찮아요)
--   node --env-file=.env scripts/migrate.js supabase/migrations/001-nickname-per-category.sql

alter table players add column if not exists category text;

-- 전체 장르에서 하나였던 닉네임 제약을 장르별 제약으로 바꿔요.
alter table players drop constraint if exists players_nickname_norm_key;
create unique index if not exists players_category_nickname_idx on players (category, nickname_norm);

-- 기존 닉네임은 처음 기록을 남긴 장르의 것으로 정해요.
with firsts as (
  select distinct on (player_id) player_id, category
  from results
  order by player_id, at
)
update players p set category = f.category
from firsts f
where p.id = f.player_id and p.category is null;

-- 다른 장르에도 기록이 있으면 그 장르용 닉네임을 따로 만들고 기록을 옮겨요.
-- (토큰은 브라우저에 남지 않아서, 복제한 닉네임의 토큰은 쓰이지 않는 값으로 둬요)
insert into players (id, category, nickname, nickname_norm, token_hash, created_at)
select p.id || ':' || r.category, r.category, p.nickname, p.nickname_norm, p.token_hash || ':' || r.category, p.created_at
from players p
join (select distinct player_id, category from results) r on r.player_id = p.id
where r.category <> p.category
on conflict do nothing;

update results r set player_id = r.player_id || ':' || r.category
from players p
where p.id = r.player_id and p.category <> r.category;

-- 기록 없이 등록만 된 닉네임은 장르가 없어서 지워요. (새로고침하면 어차피 다시 등록해야 해요)
delete from players where category is null;
