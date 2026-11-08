-- An absolute lifetime for the sessions of ADMIN and AUTHOR accounts. The start of a session is refresh_tokens.authenticated_at (V44):
-- written when the person signs in, copied unchanged by every rotation and by every session a password change or an enrollment
-- issues to the caller. From this release the backend ends such a session a fixed time after that instant (30 days unless
-- PRIVILEGED_SESSION_ABSOLUTE_TTL says otherwise), however active it was.
--
-- The sessions that were open when V44 ran carry the marker 'epoch' ("never recently authenticated"), and so do the rotations
-- of those sessions. Read as a start time it would put their end in 1970 and sign every such person out at the next refresh.
-- Give them a start that is real but still old: the first row of their session that still exists (a rotated token is kept for a
-- while after it is revoked, so for a session in daily use this is at most about a week back), and never less than a day ago, so
-- that these sessions still do not count as "recently authenticated" for the changes that ask for a recent sign-in.
UPDATE refresh_tokens rt
   SET authenticated_at = LEAST(
           (SELECT min(c.created_at) FROM refresh_tokens c WHERE c.session_id = rt.session_id),
           now() - interval '1 day')
 WHERE rt.authenticated_at = 'epoch';
