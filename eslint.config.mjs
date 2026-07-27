import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      /**
       * `ignoreRestSiblings` is the purpose-built option for the
       * destructure-to-omit idiom — `const { secret, ...rest } = obj` — where the
       * named binding exists precisely so it is *not* in `rest`. Without it, the
       * cleanest way to drop a key reads as a lint error.
       *
       * The `^_` patterns cover deliberate placeholders where a signature or tuple
       * position must be kept but the value is genuinely unused.
       */
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    /**
     * The provider layer must never be imported from a client component. The
     * `server-only` package already makes that a build error; this rule surfaces it
     * at lint time, with a message explaining the boundary rather than a bare
     * resolution failure.
     */
    files: ["components/**/*.tsx", "components/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/providers/**"],
              message:
                "Provider access is server-only. Call the /api/places/* routes from a component instead.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
