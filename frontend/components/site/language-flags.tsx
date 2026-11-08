import type { Locale } from '@/i18n/config'

/**
 * A small flag per language for the switcher: decorative, drawn inline so it renders the same everywhere (flag emoji show as two
 * letters on Windows). The language name next to it carries the meaning, so the flag is hidden from assistive technology.
 */
const FLAGS: Record<Locale, React.ReactNode> = {
  vi: (
    <>
      <rect width="60" height="40" fill="#da251d" />
      <polygon
        fill="#ffff00"
        points="30.0,9.5 32.6,17.4 40.9,17.4 34.2,22.4 36.8,30.3 30.0,25.4 23.2,30.3 25.8,22.4 19.1,17.4 27.4,17.4"
      />
    </>
  ),
  en: (
    <>
      <rect width="60" height="40" fill="#012169" />
      <path d="M0 0 60 40M60 0 0 40" stroke="#fff" strokeWidth="8" />
      <path d="M0 0 60 40M60 0 0 40" stroke="#c8102e" strokeWidth="3" />
      <path d="M30 0v40M0 20h60" stroke="#fff" strokeWidth="13" />
      <path d="M30 0v40M0 20h60" stroke="#c8102e" strokeWidth="8" />
    </>
  ),
}

export function LanguageFlag({ locale, className }: { locale: Locale; className?: string }) {
  return (
    <svg
      viewBox="0 0 60 40"
      aria-hidden="true"
      focusable="false"
      className={`h-3.5 w-5 shrink-0 rounded-[2px] ring-1 ring-black/10 ${className ?? ''}`}
    >
      <g>{FLAGS[locale]}</g>
    </svg>
  )
}
