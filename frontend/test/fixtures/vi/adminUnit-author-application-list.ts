/** Vietnamese-specific data of the author application list tests: dates as the admin prints them (UTC, medium style) and a name with diacritics. */
export const SUBMITTED_DATE_TEXT = '2 thg 10, 2026'
export const DECIDED_DATE_TEXT = '10 thg 10, 2026'

/** Typing a name with diacritics: exact case works, decomposed (NFD) letters still match, a different case does not. */
export const APPLICANT_NAME = 'Lê Thị Hà'
export const APPLICANT_NAME_LOWER_CASE = 'lê thị hà'
export const APPLICANT_NAME_TYPED = ' Lê  Thị Hà '
