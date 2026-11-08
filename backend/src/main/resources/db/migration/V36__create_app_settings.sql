-- V9D1, step 1 of 3: operational settings and the first-run state. One row (id is pinned to 1).
--
-- setup_completed says whether the first-run /setup may still claim the instance. Existing deployments must never be
-- claimable, so the row is created already completed unless the database is provably fresh: no post, image, category, tag,
-- series or newsletter subscriber, no user other than the seeded admin, and that admin still carries the untouched V8
-- development hash and no GitHub link. A database whose admin was changed through ADMIN_PASSWORD, ADMIN_EMAIL or ADMIN_GITHUB_ID, or that holds any content, is an existing
-- deployment.
CREATE TABLE app_settings (
    id                 SMALLINT PRIMARY KEY DEFAULT 1,
    setup_completed    BOOLEAN NOT NULL DEFAULT FALSE,
    setup_completed_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_app_settings_single_row CHECK (id = 1),
    CONSTRAINT chk_app_settings_completed_at CHECK (setup_completed = (setup_completed_at IS NOT NULL))
);

INSERT INTO app_settings (id, setup_completed, setup_completed_at)
SELECT 1, NOT fresh, CASE WHEN NOT fresh THEN now() END
FROM (
    SELECT NOT EXISTS (SELECT 1 FROM posts)
       AND NOT EXISTS (SELECT 1 FROM media)
       AND NOT EXISTS (SELECT 1 FROM categories)
       AND NOT EXISTS (SELECT 1 FROM tags)
       AND NOT EXISTS (SELECT 1 FROM series)
       AND NOT EXISTS (SELECT 1 FROM newsletter_subscribers)
       AND NOT EXISTS (
           SELECT 1 FROM users
           WHERE NOT (id = '00000000-0000-0000-0000-000000000001'::uuid
                      AND email = 'admin@blog.local'
                      AND github_id IS NULL
                      AND password_hash = '$argon2id$v=19$m=16384,t=2,p=1$GeDAu3H5YOn0axjjK9EcMg$mvizPPouDSMrc2M5L+aAjwv9BNgB2irzZGPc3kSjn4A'))
       AS fresh
) state;
