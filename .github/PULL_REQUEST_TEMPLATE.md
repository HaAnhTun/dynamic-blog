## What and why

<!-- One logical change. Link the issue if there is one. -->

## Checklist

- [ ] Backend: `cd backend && mvn -B -ntp clean verify` passes (needs Docker for Testcontainers)
- [ ] Frontend: `cd frontend && npm run lint && npm run typecheck && npm test` passes, and `npm run format:check`
- [ ] `python scripts/validate-english.py check --strict` passes (English only outside the allowed translation folders)
- [ ] A behavior change comes with a test at the lowest layer that proves it; a bug fix has a regression test
- [ ] No applied Flyway migration was edited (add a new one instead)
- [ ] No secrets, tokens, emails or other personal data in code, fixtures, logs or docs
- [ ] Docs and `CHANGELOG.md` updated when behavior, configuration or commands changed
- [ ] User-facing text is in `frontend/messages/*.json` for both languages
