-- Replaces the placeholder V2 seeded. This is a DEVELOPMENT credential:
-- admin@blog.local / admin12345, documented in backend/README.md. The application logs a
-- warning at startup while this hash is still in place, so an environment that never
-- changed it says so in its own log rather than looking fine.
--
-- A production mechanism for setting the real password belongs to Sprint 7.
UPDATE users
SET password_hash = '$argon2id$v=19$m=16384,t=2,p=1$GeDAu3H5YOn0axjjK9EcMg$mvizPPouDSMrc2M5L+aAjwv9BNgB2irzZGPc3kSjn4A',
    updated_at = now()
WHERE email = 'admin@blog.local';
