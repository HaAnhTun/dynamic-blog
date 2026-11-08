-- password_hash is a placeholder, not a real credential: nothing verifies
-- against it until the Auth plan (Sprint 4) implements login and replaces it.
INSERT INTO users (id, email, password_hash, display_name, role)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'admin@blog.local',
    'placeholder-set-during-auth-implementation',
    'Admin',
    'ADMIN'
);
