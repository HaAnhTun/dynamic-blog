# Contributing

Thank you for helping. This is a bilingual (English and Vietnamese) self-hostable blog engine: a Spring Boot backend, a Next.js
frontend and PostgreSQL. Small, focused changes with a test are the easiest to review.

Read these first, in this order:

1. [AGENTS.md](AGENTS.md): the short rules and the commands. It is written for people and for AI coding agents alike.
2. [docs/CONVENTIONS.md](docs/CONVENTIONS.md): the reasoning behind the rules (style, architecture checks, i18n, content language,
   site content).
3. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): running the project, the tests, CI and the E2E suite.
4. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pieces fit, and the places that break quietly.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem, do not open an issue: use
[SECURITY.md](SECURITY.md).

## Set up

You need JDK 25, Maven, Node.js 20.9 or newer, Docker and Python 3.12 or newer. Then, in three terminals:

```bash
cd backend && docker compose up -d        # PostgreSQL only
cd backend && mvn spring-boot:run         # http://localhost:8080
cd frontend && npm ci && npm run dev      # http://localhost:3000
```

A new database has no usable credential: claim it at `http://localhost:3000/setup` with the code the backend writes to
`backend/data/setup-code`. Details, GitHub sign-in on your machine and Windows notes are in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Before you open a pull request

Run the formatters, the static checks and the tests that cover your change. For a change that touches both sides, run all of them.

| Task | Command (from the folder shown) |
|---|---|
| Backend tests (Docker needed) | `cd backend && mvn -B -ntp clean test` |
| Backend full check (tests, Spotless, Checkstyle, architecture tests) | `cd backend && mvn -B -ntp clean verify` |
| Backend format | `cd backend && mvn -B -ntp spotless:apply` |
| Frontend checks | `cd frontend && npm run lint && npm run typecheck && npm test` |
| Frontend format (check with `npm run format:check`) | `cd frontend && npm run format` |
| Frontend build | `cd frontend && npm run build` |
| English guard | `python scripts/validate-english.py check --strict` |
| Personal data guard (skips without a private blocklist) | `python scripts/check-personal-data.py` |

The end-to-end suite needs a dedicated database and free ports; see "E2E" in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#e2e-playwright).
CI runs all of this on every pull request.

## The rules that matter most

- **Every behavior change comes with a test** at the lowest layer that proves it. A bug fix comes with a regression test. Never
  disable a rule, a check or a test, and never delete or weaken a test, to make a build green: fix the cause.
- **Do not add a dependency or a framework, or change the architecture,** without a documented reason in the pull request. Reuse
  what exists instead of creating a second DTO, entity or helper.
- **Never edit an applied Flyway migration**, not even a comment: Flyway validates checksums and the backend refuses to start. Add a
  new migration with the next free number.
- **Authorization is enforced in the backend.** The frontend only hides things. A draft or private data never appears in a public
  response.
- **No secrets, tokens, passwords, emails or personal data** in code, logs, fixtures, docs or test output. Never log search queries,
  uploaded content or tokens. Everything "about one person" is site content in the database, not code; defaults are neutral.
- **Formatting belongs to the formatters** (palantir-java-format through Spotless, Prettier). Do not hand-format, and do not mix a
  reformat with a behavior change in one commit.

## English only, and internationalization

- **Code, comments, identifiers, test titles, commit messages and product docs are in English.** The guard
  (`python scripts/validate-english.py check --strict`) enforces it. Vietnamese letters are allowed only in `frontend/messages/vi.json`,
  `frontend/content/`, `docs/vi/`, `fixtures/vi/` folders, `backend/src/main/resources/sample-content/vi/` and the packaged template
  example `backend/src/main/resources/site-import/defaults-vi.json`.
- **Public frontend code is locale-aware.** Routes live under `app/[locale]/(site)`; links and navigation come from
  `@/i18n/navigation`; every user-facing string belongs in `frontend/messages/*.json` with English semantic keys and ICU syntax; no
  literal text in components (a test enforces it); no hard-coded locale in `Intl` calls (use `lib/format.ts`). Tests use `msg` and
  `renderWithIntl`, not translated literals. Use the terms of [docs/vi/glossary.md](docs/vi/glossary.md) for Vietnamese.
- **Content is bilingual:** validate languages through `Languages`, send the page locale as `lang` from public pages, and follow the
  translation-group rules in [docs/CONVENTIONS.md](docs/CONVENTIONS.md), section 5.

### Adding a language

A new locale is a larger change than a translation: the set of languages is pinned by database constraints and by the frontend's
`LOCALES`, so it needs a migration, a frontend change and a complete message catalog. Read [docs/CONTENT-AND-I18N.md](docs/CONTENT-AND-I18N.md)
for the steps, and open an issue to agree on it before you start. Fixing or improving an existing translation is a plain pull
request on `frontend/messages/<locale>.json`, `docs/vi/` or the sample content; the catalog tests tell you if keys or ICU arguments
drifted.

## Commits and pull requests

- Branches: `feat/<topic>` or `fix/<topic>`.
- Commit messages: a short imperative English summary, optionally with a prefix such as `fix:` or `feat:`. One logical change per
  commit.
- A commit that only reformats code is added to `.git-blame-ignore-revs` (when that file exists in your checkout), so that
  `git blame` skips it. To use the file once: `git config blame.ignoreRevsFile .git-blame-ignore-revs`.
- In the pull request, say what changed and why, how you tested it, and, if you changed a convention, a command or an enforced
  check, update `AGENTS.md` and `docs/CONVENTIONS.md` in the same pull request.
- Fill in the pull request template. Keep screenshots free of personal data.

## Reporting bugs and asking for features

Use the issue templates. For a bug, give the version (or commit), what you did, what you expected, what happened, and the relevant
backend or frontend log lines (without secrets). For a feature, describe the problem first.

## License

By contributing you agree that your contribution is released under the project's [MIT license](LICENSE).
