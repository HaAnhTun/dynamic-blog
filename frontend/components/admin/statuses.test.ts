import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { translatorFor } from '@/test/intl'
import {
  AUTHOR_APPLICATION_STATUS,
  COMMENT_STATUS,
  USER_ROLE,
  USER_STATUS,
  commentStatusLook,
  roleLabel,
  userStatusLook,
} from './statuses'
import { msg } from '@/test/render-intl'

const t = translatorFor('vi', 'Admin.statuses')

/** The real Tailwind 4 color palette the site uses: `--color-<name>-<shade>: oklch(L% C h);`. */
const THEME = readFileSync(join(process.cwd(), 'node_modules/tailwindcss/theme.css'), 'utf8')

function oklchOf(color: string): [number, number, number] {
  const key = `--color-${color}: oklch(`
  const start = THEME.indexOf(key)
  if (start === -1) throw new Error(`Color ${color} not found in the Tailwind theme.css`)
  const [lightness, chroma, hue] = THEME.slice(start + key.length, THEME.indexOf(')', start)).split(' ')
  return [Number.parseFloat(lightness!) / 100, Number(chroma), Number(hue)]
}

/** WCAG relative luminance: OKLCH → OKLab → linear sRGB (clipped to [0, 1] like the browser). */
function relativeLuminance([lightness, chroma, hue]: [number, number, number]): number {
  const a = chroma * Math.cos((hue * Math.PI) / 180)
  const b = chroma * Math.sin((hue * Math.PI) / 180)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const [red, green, blue] = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => Math.min(1, Math.max(0, channel)))
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
}

/** Contrast ratio of the class `text-<color>-<shade>` on a white background (luminance 1). */
function contrastOnWhite(tone: string): number {
  return 1.05 / (relativeLuminance(oklchOf(tone.replace(/^text-/, ''))) + 0.05)
}

describe('statuses', () => {
  it('comment labels match the filter text exactly: "Visible", "Hidden", "Deleted"', () => {
    expect(Object.values(COMMENT_STATUS).map((look) => t(look.labelKey))).toEqual([
      msg('Admin.statuses.comment.VISIBLE'),
      msg('Admin.statuses.comment.HIDDEN'),
      msg('Admin.statuses.comment.DELETED'),
    ])
    expect(commentStatusLook('HIDDEN', t)).toEqual({
      label: msg('Admin.statuses.comment.HIDDEN'),
      tone: COMMENT_STATUS.HIDDEN.tone,
    })
  })

  it('account status and role have Vietnamese labels', () => {
    expect(userStatusLook('ACTIVE', t).label).toBe(msg('Admin.statuses.user.ACTIVE'))
    // The status is the suspended label, which does not repeat the text of the suspend button in the neighboring row.
    expect(userStatusLook('SUSPENDED', t).label).toBe(msg('Admin.statuses.user.SUSPENDED'))
    expect(roleLabel('USER', t)).toBe(msg('Admin.statuses.role.USER'))
    expect(roleLabel('AUTHOR', t)).toBe(msg('Site.authorBox.eyebrow'))
    expect(roleLabel('ADMIN', t)).toBe(msg('Site.account.admin'))
    expect(Object.keys(USER_STATUS)).toEqual(['ACTIVE', 'SUSPENDED'])
    expect(Object.keys(USER_ROLE)).toEqual(['USER', 'AUTHOR', 'ADMIN'])
  })

  it('an unknown value (the backend adds one later) shows its name verbatim, never an empty cell', () => {
    expect(commentStatusLook('SPAM', t)).toEqual({ label: 'SPAM', tone: 'text-slate-600' })
    expect(userStatusLook('BANNED', t)).toEqual({ label: 'BANNED', tone: 'text-slate-600' })
    expect(roleLabel('EDITOR', t)).toBe('EDITOR')
  })

  it('the contrast measurement matches the known figures of the Tailwind 4 palette', () => {
    // Calibrates the measurement below itself: the pale tones fail the standard, the tone in use passes.
    expect(contrastOnWhite('text-slate-400')).toBeCloseTo(2.63, 1)
    expect(contrastOnWhite('text-slate-500')).toBeCloseTo(4.77, 1)
    expect(contrastOnWhite('text-amber-500')).toBeCloseTo(2.15, 1)
    expect(contrastOnWhite('text-emerald-500')).toBeCloseTo(2.46, 1)
    expect(contrastOnWhite('text-red-500')).toBeCloseTo(3.82, 1)
    expect(contrastOnWhite('text-emerald-700')).toBeCloseTo(5.37, 1)
  })

  it('text colors have enough contrast on a white background: at least 4.5:1 (WCAG AA for 13px text), measured on the real palette', () => {
    const looks = [
      ...[...Object.values(COMMENT_STATUS), ...Object.values(USER_STATUS), ...Object.values(AUTHOR_APPLICATION_STATUS)].map(
        ({ labelKey, tone }) => ({ label: t(labelKey), tone }),
      ),
      commentStatusLook('SPAM', t),
    ]
    for (const { label, tone } of looks) {
      expect(tone, label).toMatch(/^text-[a-z]+-[0-9]{3}$/)
      expect(contrastOnWhite(tone), `${label}: ${tone}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
