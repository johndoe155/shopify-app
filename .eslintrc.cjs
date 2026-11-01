module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2022, sourceType: "module", ecmaFeatures: { jsx: true } },
  plugins: ["@typescript-eslint", "react-hooks"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "error",
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
    "no-console": "off",
  },
  ignorePatterns: ["build/", "node_modules/", "extensions/", "*.cjs", "*.mjs"],
  overrides: [
    {
      // The demo-mode server and CLI scripts legitimately log to stdout.
      files: ["scripts/**", "app/demo/**", "tests/**", "*.config.ts"],
      rules: { "@typescript-eslint/no-explicit-any": "off" },
    },
  ],
};
