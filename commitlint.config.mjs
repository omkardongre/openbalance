export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Keep the project's technical, bullet-based message style valid.
    "type-enum": [
      2,
      "always",
      [
        "build",
        "chore",
        "ci",
        "docs",
        "feat",
        "fix",
        "infra",
        "perf",
        "refactor",
        "revert",
        "style",
        "test",
      ],
    ],
    "body-leading-blank": [0],
    "footer-leading-blank": [0],
    "header-max-length": [2, "always", 100],
    "body-max-line-length": [2, "always", 200],
  },
};
