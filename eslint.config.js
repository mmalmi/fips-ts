import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "node_modules/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "curly": ["error", "multi-line", "consistent"],
      "eqeqeq": ["error", "always", { null: "ignore" }],
      "max-nested-callbacks": ["error", 4],
      "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
      "no-else-return": ["error", { allowElseIf: false }],
      "no-lonely-if": "error",
      "no-promise-executor-return": "error",
      "no-template-curly-in-string": "error",
      "no-unneeded-ternary": "error",
      "no-unmodified-loop-condition": "error",
    },
  },
  {
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
    rules: {
      "complexity": ["error", 20],
      "max-depth": ["error", 4],
      "max-lines": ["error", { max: 800, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 120, skipBlankLines: true, skipComments: true }],
      "max-params": ["error", 6],
    },
  },
  {
    // Existing transport/session orchestration debt. New routing and wire
    // functionality belongs in focused modules covered by the limits above.
    files: ["packages/core/src/node/FipsNode.ts"],
    rules: {
      "complexity": ["error", 50],
      "max-depth": ["error", 5],
      "max-lines": ["error", { max: 1_600, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 240, skipBlankLines: true, skipComments: true }],
    },
  },
);
