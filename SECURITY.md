# Security policy

## Supported versions

Blog Engine is at version `1.0.0-rc.1`, a release candidate. Security fixes go to the latest release and, until a final `1.0.0`
exists, to the latest release candidate. Older versions are not patched: upgrade
([docs/UPGRADING.md](docs/UPGRADING.md)).

| Version | Supported |
|---|---|
| latest release, or the latest release candidate until `1.0.0` | yes |
| anything older | no |

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Report it privately with GitHub's **private vulnerability reporting**: open the **Security** tab of the repository, choose **Report a
vulnerability** and fill in the form. Only you and the maintainers can read the report, nobody has to share an email address, and the
discussion, the fix and the advisory stay in one place.

If the **Report a vulnerability** button is missing (private reporting is switched off, for example in a fork or before the
maintainers have enabled it), open a public issue titled "Security contact request" with **no details at all** (not the component, not
the symptom). A maintainer answers there with a private way to send the report. Never put the details in that issue.

Include what you need to reproduce the problem: the version or commit, how the site is deployed (Docker Compose or other), the steps,
what you expected and what happened, and the impact you see. Do not include real credentials, tokens or other people's data; if you
had to touch real data to prove the issue, say so and keep what you saw to the minimum. A proof of concept against your own
installation is best.

## What to expect

This is a small open-source project run by volunteers, so there is no service-level agreement. The maintainers will:

- acknowledge your report when they have read it, and tell you if they need more information;
- investigate and tell you whether they consider it a vulnerability, and why;
- work on a fix and agree a disclosure date with you, crediting you in the changelog if you want to be credited;
- publish the fix, with an advisory when the issue affects deployed sites, and a note in [CHANGELOG.md](CHANGELOG.md).

Please give the maintainers a reasonable time to fix the problem before you publish details.

## Scope

In scope: the code in this repository (backend, frontend, Compose and proxy examples, scripts) and its documented default
configuration. Examples: authentication or authorization bypass, a draft or private data in a public response, exposure of a
secret, injection, cross-site scripting through content the product renders, request forgery, unsafe handling of uploads, and the
first-run setup flow.

Out of scope: problems that need a malicious server operator or access to `.env`, the database or the setup code file; denial of
service by raw traffic volume; missing hardening that [docs/SECURITY.md](docs/SECURITY.md) already lists as not protected; findings
in a site that runs modified code or non-default, unsafe settings; social engineering; vulnerabilities in third-party software
(report those upstream; tell us if our configuration makes them worse).

## Hardening your own installation

[docs/SECURITY.md](docs/SECURITY.md) describes the security model, the rate limits, the headers, the first-run setup code, and what
is not protected. Keep `.env` and database backups private, serve the site over HTTPS, and keep Next.js behind the reverse proxy.
