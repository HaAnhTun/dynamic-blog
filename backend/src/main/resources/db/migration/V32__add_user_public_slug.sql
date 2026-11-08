-- T-003: a public, stable handle for every account, for the profile page (GET /api/v1/users/{slug}) and the filter
-- GET /api/v1/posts?author= (V7a D10 dropped the per-author archive page because exactly this did not exist yet). Not the internal id, and not
-- github_login (changeable, not unique): generated once when the account is created and never changed afterwards.
--
-- Existing rows are filled by the same rule that PublicSlugs (Java) uses for new rows: the base comes from github_login, or from
-- display_name when that is empty; accents stripped (unaccent from V23, plus the Vietnamese d-with-stroke letter, upper and lower case, mapped to d), lowercase, each run of characters outside [a-z0-9] becomes one '-',
-- '-' trimmed at both ends, cut to 40 characters (no trailing '-'), and 'nguoi-dung' (a Vietnamese placeholder meaning "user") if empty. On collisions, rows are processed in
-- (created_at, id) order, and each row takes the smallest free value among base, base-2, base-3…: the oldest row keeps the base, and an
-- existing login of the form "base-2" never collides with another row's suffix.
ALTER TABLE users ADD COLUMN public_slug VARCHAR(64);
-- UNIQUE before filling: Postgres treats each NULL as distinct, and its index serves the duplicate probe inside the loop.
ALTER TABLE users ADD CONSTRAINT uq_users_public_slug UNIQUE (public_slug);

DO $$
DECLARE
    account   RECORD;
    base      TEXT;
    candidate TEXT;
    suffix    INT;
BEGIN
    FOR account IN SELECT id, github_login, display_name FROM users ORDER BY created_at, id LOOP
        base := lower(unaccent(translate(coalesce(nullif(account.github_login, ''), account.display_name),
                                         'đĐ', 'dd')));
        base := trim(BOTH '-' FROM regexp_replace(base, '[^a-z0-9]+', '-', 'g'));
        base := rtrim(left(base, 40), '-');
        IF base = '' THEN
            base := 'nguoi-dung';
        END IF;
        candidate := base;
        suffix := 1;
        WHILE EXISTS (SELECT 1 FROM users WHERE public_slug = candidate) LOOP
            suffix := suffix + 1;
            candidate := base || '-' || suffix;
        END LOOP;
        UPDATE users SET public_slug = candidate WHERE id = account.id;
    END LOOP;
END $$;

ALTER TABLE users ALTER COLUMN public_slug SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT chk_users_public_slug CHECK (public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
