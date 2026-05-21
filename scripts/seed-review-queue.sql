-- Seed a varied set of pending entity_review_queue rows for UI testing.
-- Idempotent: cleans up its own previous seed rows (id prefix `seed-ecr03b-`).
-- Run with: sqlite3 data/sketch.db < scripts/seed-review-queue.sql

DELETE FROM entity_review_evidence WHERE review_id LIKE 'seed-ecr03b-%';
DELETE FROM entity_review_queue WHERE id LIKE 'seed-ecr03b-%';

-- triggered_by_user_id we'll reuse for all rows (the first user)
-- (252e43de-81f9-47f6-9e61-e93a1d93539e)

-- 1) Token-superset match → suggests Himanshu Kalra. Mixed evidence.
INSERT INTO entity_review_queue
  (id, proposed_name, normalized_name, entity_type, proposed_email,
   candidate_entity_id, candidate_score, candidate_reason, candidate_generated_at,
   first_seen_at, last_seen_at, occurrence_count, status, triggered_by_user_id)
VALUES
  ('seed-ecr03b-himanshu', 'Himanshu R Kalra', 'himanshu r kalra', 'person', NULL,
   'e12c110a-4377-4770-8799-b6202e4c7793', 0.92, 'token-superset', '2026-05-20T06:00:00.000Z',
   '2026-05-20T06:00:00.000Z', '2026-05-20T06:30:00.000Z', 3, 'pending',
   '252e43de-81f9-47f6-9e61-e93a1d93539e');

INSERT INTO entity_review_evidence (id, review_id, indexed_file_id, source, seen_at) VALUES
  ('seed-ev-himanshu-1', 'seed-ecr03b-himanshu', '4b03d2f1-fef1-4ca0-9d6a-24e4883c80dc', 'fireflies', '2026-05-20T06:00:00.000Z'),
  ('seed-ev-himanshu-2', 'seed-ecr03b-himanshu', '32bc7c3a-dfd6-41cf-abc0-363d5768cd14', 'fireflies', '2026-05-20T06:15:00.000Z'),
  ('seed-ev-himanshu-3', 'seed-ecr03b-himanshu', 'beae5076-c852-42ff-9cd3-9765b5ee9b57', 'clickup',   '2026-05-20T06:30:00.000Z');

-- 2) Email-match → suggests Canvas Ops (which has email saurabhbothra@habuild.in).
INSERT INTO entity_review_queue
  (id, proposed_name, normalized_name, entity_type, proposed_email,
   candidate_entity_id, candidate_score, candidate_reason, candidate_generated_at,
   first_seen_at, last_seen_at, occurrence_count, status, triggered_by_user_id)
VALUES
  ('seed-ecr03b-saurabh', 'Saurabh Bothra', 'saurabh bothra', 'person', 'saurabhbothra@habuild.in',
   '1f9cf856-5b98-4397-832b-93a44b20da8b', 0.95, 'email-match', '2026-05-20T05:00:00.000Z',
   '2026-05-20T05:00:00.000Z', '2026-05-20T05:30:00.000Z', 2, 'pending',
   '252e43de-81f9-47f6-9e61-e93a1d93539e');

INSERT INTO entity_review_evidence (id, review_id, indexed_file_id, source, seen_at) VALUES
  ('seed-ev-saurabh-1', 'seed-ecr03b-saurabh', 'f1a53971-04f7-48ce-ae7e-b07e8d8b085f', 'clickup',   '2026-05-20T05:00:00.000Z'),
  ('seed-ev-saurabh-2', 'seed-ecr03b-saurabh', '8dafdfbe-c200-49c8-9c16-d095488f8c75', 'fireflies', '2026-05-20T05:30:00.000Z');

-- 3) Close-spelling match → suggests Vedant Parikh.
INSERT INTO entity_review_queue
  (id, proposed_name, normalized_name, entity_type, proposed_email,
   candidate_entity_id, candidate_score, candidate_reason, candidate_generated_at,
   first_seen_at, last_seen_at, occurrence_count, status, triggered_by_user_id)
VALUES
  ('seed-ecr03b-vedant', 'Vedant Parik', 'vedant parik', 'person', NULL,
   'e9355071-be1f-4687-adf8-3cec2aa54860', 0.86, 'edit-distance-1', '2026-05-20T04:00:00.000Z',
   '2026-05-20T04:00:00.000Z', '2026-05-20T04:00:00.000Z', 1, 'pending',
   '252e43de-81f9-47f6-9e61-e93a1d93539e');

INSERT INTO entity_review_evidence (id, review_id, indexed_file_id, source, seen_at) VALUES
  ('seed-ev-vedant-1', 'seed-ecr03b-vedant', '4b03d2f1-fef1-4ca0-9d6a-24e4883c80dc', 'fireflies', '2026-05-20T04:00:00.000Z');

-- 4) Token-superset (multi-evidence) → suggests Ankush Thakur.
INSERT INTO entity_review_queue
  (id, proposed_name, normalized_name, entity_type, proposed_email,
   candidate_entity_id, candidate_score, candidate_reason, candidate_generated_at,
   first_seen_at, last_seen_at, occurrence_count, status, triggered_by_user_id)
VALUES
  ('seed-ecr03b-ankush', 'Ankush T', 'ankush t', 'person', NULL,
   '90d0cd38-02c1-4ae4-b1a3-5a07f47307e9', 0.90, 'token-superset', '2026-05-20T03:00:00.000Z',
   '2026-05-20T03:00:00.000Z', '2026-05-20T03:45:00.000Z', 3, 'pending',
   '252e43de-81f9-47f6-9e61-e93a1d93539e');

INSERT INTO entity_review_evidence (id, review_id, indexed_file_id, source, seen_at) VALUES
  ('seed-ev-ankush-1', 'seed-ecr03b-ankush', '4b03d2f1-fef1-4ca0-9d6a-24e4883c80dc', 'fireflies', '2026-05-20T03:00:00.000Z'),
  ('seed-ev-ankush-2', 'seed-ecr03b-ankush', '32bc7c3a-dfd6-41cf-abc0-363d5768cd14', 'fireflies', '2026-05-20T03:20:00.000Z'),
  ('seed-ev-ankush-3', 'seed-ecr03b-ankush', 'beae5076-c852-42ff-9cd3-9765b5ee9b57', 'clickup',   '2026-05-20T03:45:00.000Z');

-- 5) Company proposal with no candidate match.
INSERT INTO entity_review_queue
  (id, proposed_name, normalized_name, entity_type, proposed_email,
   candidate_entity_id, candidate_score, candidate_reason, candidate_generated_at,
   first_seen_at, last_seen_at, occurrence_count, status, triggered_by_user_id)
VALUES
  ('seed-ecr03b-anthropic', 'Anthropic', 'anthropic', 'company', NULL,
   NULL, NULL, NULL, NULL,
   '2026-05-20T02:00:00.000Z', '2026-05-20T02:00:00.000Z', 1, 'pending',
   '252e43de-81f9-47f6-9e61-e93a1d93539e');

INSERT INTO entity_review_evidence (id, review_id, indexed_file_id, source, seen_at) VALUES
  ('seed-ev-anthropic-1', 'seed-ecr03b-anthropic', 'f1a53971-04f7-48ce-ae7e-b07e8d8b085f', 'clickup', '2026-05-20T02:00:00.000Z');

-- 6) Token-superset → suggests Ohoud Zitan.
INSERT INTO entity_review_queue
  (id, proposed_name, normalized_name, entity_type, proposed_email,
   candidate_entity_id, candidate_score, candidate_reason, candidate_generated_at,
   first_seen_at, last_seen_at, occurrence_count, status, triggered_by_user_id)
VALUES
  ('seed-ecr03b-ohoud', 'Ohoud Z', 'ohoud z', 'person', NULL,
   '81dc18b6-64a2-47e7-89a9-59e267ce30d7', 0.88, 'token-superset', '2026-05-20T01:00:00.000Z',
   '2026-05-20T01:00:00.000Z', '2026-05-20T01:00:00.000Z', 1, 'pending',
   '252e43de-81f9-47f6-9e61-e93a1d93539e');

INSERT INTO entity_review_evidence (id, review_id, indexed_file_id, source, seen_at) VALUES
  ('seed-ev-ohoud-1', 'seed-ecr03b-ohoud', '8dafdfbe-c200-49c8-9c16-d095488f8c75', 'fireflies', '2026-05-20T01:00:00.000Z');

-- 7) Orphan (no candidate match) — second one so the orphan UI is well-tested.
INSERT INTO entity_review_queue
  (id, proposed_name, normalized_name, entity_type, proposed_email,
   candidate_entity_id, candidate_score, candidate_reason, candidate_generated_at,
   first_seen_at, last_seen_at, occurrence_count, status, triggered_by_user_id)
VALUES
  ('seed-ecr03b-orphan', 'Anonymous Sender', 'anonymous sender', 'person', NULL,
   NULL, NULL, NULL, NULL,
   '2026-05-20T00:00:00.000Z', '2026-05-20T00:00:00.000Z', 1, 'pending',
   '252e43de-81f9-47f6-9e61-e93a1d93539e');

INSERT INTO entity_review_evidence (id, review_id, indexed_file_id, source, seen_at) VALUES
  ('seed-ev-orphan-1', 'seed-ecr03b-orphan', '32bc7c3a-dfd6-41cf-abc0-363d5768cd14', 'fireflies', '2026-05-20T00:00:00.000Z');

SELECT
  COUNT(*) AS pending_seeded
FROM entity_review_queue
WHERE id LIKE 'seed-ecr03b-%' AND status = 'pending';
