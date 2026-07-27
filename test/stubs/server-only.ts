/**
 * Test stub for the `server-only` package.
 *
 * The real package deliberately resolves to a throwing module outside a React
 * Server Component bundle, which is what gives us a build-time error if a client
 * component ever imports the provider layer. That same behaviour makes the provider
 * modules unimportable under vitest, so this empty stub stands in — see the alias in
 * `vitest.config.ts`.
 *
 * The guard itself is unaffected: `next build` still resolves the real package.
 */
export {};
