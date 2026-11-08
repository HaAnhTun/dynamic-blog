/**
 * The address of the backend API, from the run-time variable `API_BASE_URL`. One function for every caller (twenty modules used to read
 * `process.env.API_BASE_URL ?? 'http://localhost:8080'` themselves). The rule, and why it exists, is in `scripts/api-base-url-rule.mjs`,
 * which `scripts/start-check.mjs` also runs so that the production image refuses to start on a value it would reject here.
 */
export { apiBaseUrl } from '../scripts/api-base-url-rule.mjs'
