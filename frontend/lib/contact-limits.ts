/**
 * Limits of a contact message, the same numbers the backend checks (POST /api/v1/contact/messages). Shared by the form
 * (components/site/ContactForm.tsx) and its BFF route (app/api/contact/route.ts), so the two cannot drift apart.
 */
export const CONTACT_LIMITS = {
  nameMax: 100,
  emailMax: 254,
  subjectMax: 150,
  messageMin: 10,
  messageMax: 5000,
} as const

/** Rough check of the shape; the real address rules are the backend's call. */
export const CONTACT_EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
