// Object form. The v3 array form, and a bare "tailwindcss" plugin key, both fail.
// Named rather than an inline `export default {...}`: eslint-config-next warns on
// anonymous default exports, and --max-warnings=0 turns that warning into a failure.
const postcssConfig = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}

export default postcssConfig
