/** Vietnamese relative-time output of `Intl.RelativeTimeFormat('vi', { numeric: 'always' })`: a fact about the locale data, not site copy. */
export const AGO_VI = {
  minute1: '1 phút trước',
  minutes3: '3 phút trước',
  minutes59: '59 phút trước',
  hour1: '1 giờ trước',
  hours23: '23 giờ trước',
  day1: '1 ngày trước',
  days29: '29 ngày trước',
  month1: '1 tháng trước',
  months12: '12 tháng trước',
  year1: '1 năm trước',
  years3: '3 năm trước',
} as const

/** Vietnamese long month names as `formatMonth` and `formatDate` print them. */
export const MONTH_VI = (month: number, year: number) => `tháng ${month} năm ${year}`

/** "3 tháng 10": the day and month as `Intl.DateTimeFormat('vi')` prints them. */
export const DAY_MONTH_VI = (day: number, month: number) => `${day} tháng ${month}`

/** "6 tháng 10, 2026": the long date of the post page. */
export const DATE_VI = (day: number, month: number, year: number) => `${DAY_MONTH_VI(day, month)}, ${year}`
