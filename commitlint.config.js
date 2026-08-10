// Conventional Commits, matching CONTRIBUTING.md.
//
// The PR *title* is already checked by semantic-pr-title.yml. This checks the
// individual *commit* messages, which nothing validated before, and which end up
// in the changelog because releases squash-merge on the PR title but rebase-merge
// keeps them verbatim.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // CONTRIBUTING.md lists exactly these types.
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'chore', 'perf', 'refactor', 'test', 'ci', 'build', 'revert'],
    ],
    // Scopes in this repo are mixed case on purpose: fix(Auth), ci(ios-release).
    'scope-case': [0],
    // Subjects here are sentences, not slugs; only forbid a trailing period.
    'subject-case': [0],
    'header-max-length': [2, 'always', 100],
    // Bodies wrap at 80 in this repo, but semantic-release and revert commits
    // generate longer lines, so warn instead of failing.
    'body-max-line-length': [1, 'always', 100],
  },
};
