-- Ensure one participation row per (competition, user) pair.
DELETE FROM competition_participants cp
USING competition_participants newer
WHERE cp.id < newer.id
  AND cp.competition_id = newer.competition_id
  AND cp.user_id = newer.user_id;

ALTER TABLE competition_participants
ADD CONSTRAINT competition_participants_competition_id_user_id_key
UNIQUE (competition_id, user_id);
