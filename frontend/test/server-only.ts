// Stand-in for the `server-only` marker package under Vitest.
// Next aliases `server-only` at the bundler level; it is not in node_modules, so
// Vite cannot resolve it and any test importing a module that imports it fails to
// load. Aliasing it to this empty module keeps the build-time guard real while
// letting the same module be unit-tested.
export {}
