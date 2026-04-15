/**
 * Built-in Filter Rules
 * 
 * Declarative rules for formatting command output.
 * Categories: git, linters, testing, package managers, docker, github, misc
 */

import type { FilterRule } from "./types.js";

// ============================================================================
// GIT
// ============================================================================

const gitFilters: FilterRule[] = [
  {
    name: 'git-status',
    description: 'Strip git hints and empty lines',
    matchCommand: '^git\\s+status',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^\\s*\\(use "', '^\\s*\\(create/copy'],
      onEmpty: '✓ Working tree clean',
    },
  },
  {
    name: 'git-add-commit-push',
    description: 'Ultra-compact git confirmations',
    matchCommand: '^git\\s+(add|commit|push|pull|fetch|checkout|branch|merge|rebase|stash|reset|revert)',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^hint:', '^remote:', '^Updating', '^Fast-forward'],
      maxLines: 8,
    },
  },
];

// ============================================================================
// LINTERS
// ============================================================================

const linterFilters: FilterRule[] = [
  {
    name: 'biome',
    description: 'Strip Biome decorations and verbose output',
    matchCommand: 'biome\\s+(check|lint|format)',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^Checked', '^Fixed', '^ℹ', '^━', 'files? (would|will) be'],
      maxLines: 30,
    },
  },
  {
    name: 'eslint',
    description: 'Keep only errors and warnings',
    matchCommand: 'eslint',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^$', 'problems?\\s*\\('],
      maxLines: 50,
    },
  },
  {
    name: 'ruff-check',
    description: 'Compact Python linting output',
    matchCommand: 'ruff\\s+(check|format)',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^Found', '^\\d+ files?'],
      maxLines: 30,
    },
  },
];

// ============================================================================
// TESTING
// ============================================================================

const testingFilters: FilterRule[] = [
  {
    name: 'cargo-test',
    description: 'Compact Rust test output',
    matchCommand: 'cargo\\s+test',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^\\s+Running', '^\\s+Compiling', '^\\s+Finished'],
      maxLines: 30,
    },
  },
  {
    name: 'pytest',
    description: 'Strip pytest headers and timing',
    matchCommand: 'pytest|python.*-m\\s+pytest',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^={2,}', '^platform', '^cachedir', '^rootdir', '^plugins:'],
      maxLines: 50,
    },
  },
  {
    name: 'go-test',
    description: 'Compact Go test output',
    matchCommand: 'go\\s+test',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^\\?', '\\[no test files\\]'],
      maxLines: 30,
    },
  },
  {
    name: 'npm-test',
    description: 'Strip npm lifecycle scripts noise',
    matchCommand: 'npm\\s+(test|run)',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^>', '^npm', 'WARN'],
      maxLines: 50,
    },
  },
];

// ============================================================================
// PACKAGE MANAGERS
// ============================================================================

const packageManagerFilters: FilterRule[] = [
  {
    name: 'pnpm-install',
    description: 'Ultra-compact pnpm install',
    matchCommand: 'pnpm\\s+(install|i|add)',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^Packages:', '^Progress:', 'packages are looking', 'Lockfile'],
      maxLines: 10,
      onEmpty: '✓ Dependencies installed',
    },
  },
  {
    name: 'bun-install',
    description: 'Compact bun install',
    matchCommand: 'bun\\s+(install|i|add)',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^bun install', '^Resolving'],
      maxLines: 10,
      onEmpty: '✓ Dependencies installed',
    },
  },
  {
    name: 'npm-list',
    description: 'Strip npm list tree decorations',
    matchCommand: 'npm\\s+list',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '├', '└', '│'],
      maxLines: 30,
    },
  },
];

// ============================================================================
// DOCKER
// ============================================================================

const dockerFilters: FilterRule[] = [
  {
    name: 'docker-ps',
    description: 'Compact docker container list',
    matchCommand: 'docker\\s+(ps|container)',
    pipeline: {
      stripAnsi: true,
      keepLines: ['^CONTAINER|^[a-f0-9]{12}'],
      maxLines: 20,
    },
  },
  {
    name: 'docker-build',
    description: 'Strip docker build progress',
    matchCommand: 'docker\\s+build',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^#\\d+', '^--->', '^Removing', '^Successfully'],
      maxLines: 30,
    },
  },
];

// ============================================================================
// GITHUB CLI
// ============================================================================

const githubFilters: FilterRule[] = [
  {
    name: 'gh-pr-list',
    description: 'Compact PR list',
    matchCommand: 'gh\\s+pr\\s+list',
    pipeline: { stripAnsi: true, maxLines: 20 },
  },
  {
    name: 'gh-pr-view',
    description: 'Strip PR metadata noise',
    matchCommand: 'gh\\s+pr\\s+(view|status)',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^--', '^labels:', '^projects:'],
      maxLines: 30,
    },
  },
  {
    name: 'gh-issue-list',
    description: 'Compact issue list',
    matchCommand: 'gh\\s+issue\\s+list',
    pipeline: { stripAnsi: true, maxLines: 20 },
  },
  {
    name: 'gh-run-list',
    description: 'Compact workflow runs',
    matchCommand: 'gh\\s+run\\s+list',
    pipeline: { stripAnsi: true, maxLines: 15 },
  },
  {
    name: 'gh-pr-checks',
    description: 'Strip check details',
    matchCommand: 'gh\\s+pr\\s+checks',
    pipeline: { stripAnsi: true, maxLines: 20 },
  },
];

// ============================================================================
// MISC
// ============================================================================

const miscFilters: FilterRule[] = [
  {
    name: 'env-list',
    description: 'Sort and limit env output',
    matchCommand: '^env$|^printenv$',
    pipeline: { stripAnsi: true, maxLines: 50 },
  },
  {
    name: 'ps-list',
    description: 'Compact process list',
    matchCommand: '^ps\\s',
    pipeline: { stripAnsi: true, maxLines: 30 },
  },
  {
    name: 'tree',
    description: 'Limit tree depth output',
    matchCommand: '^tree\\s',
    pipeline: { stripAnsi: true, maxLines: 50 },
  },
  {
    name: 'turbo',
    description: 'Strip turborepo cache info',
    matchCommand: 'turbo\\s+run',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', 'cache (hit|miss)', '^•'],
      maxLines: 30,
    },
  },
  {
    name: 'make',
    description: 'Strip make entering/leaving',
    matchCommand: '^make\\s',
    pipeline: {
      stripAnsi: true,
      stripLines: ['Entering directory', 'Leaving directory', '^make\\['],
      maxLines: 50,
    },
  },
];

// ============================================================================
// KUBERNETES
// ============================================================================

const kubernetesFilters: FilterRule[] = [
  {
    name: 'kubectl-get',
    description: 'Compact k8s resources',
    matchCommand: '\\bkubectl\\s+(get|describe)\\b',
    pipeline: { stripAnsi: true, maxLines: 45 },
  },
  {
    name: 'kubectl-logs',
    description: 'Compact pod logs',
    matchCommand: '\\bkubectl\\s+logs\\b',
    pipeline: { stripAnsi: true, maxLines: 55 },
  },
];

// ============================================================================
// CLOUD (AWS)
// ============================================================================

const cloudFilters: FilterRule[] = [
  {
    name: 'aws-cli',
    description: 'Compact AWS output',
    matchCommand: '\\baws\\s+',
    pipeline: { stripAnsi: true, maxLines: 42 },
  },
];

// ============================================================================
// NETWORK
// ============================================================================

const networkFilters: FilterRule[] = [
  {
    name: 'curl-wget',
    description: 'Strip progress bars',
    matchCommand: '\\b(curl|wget)\\s+',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*%', '^\\s*\\d+\\s+\\d+', '^--', '^\\s*$'],
      maxLines: 60,
    },
  },
  {
    name: 'ping',
    description: 'Keep ping summary only',
    matchCommand: '^ping\\b',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^PING ', '^Pinging ', '^\\d+ bytes from ', '^Reply from .+: bytes=', '^\\s*$'],
      maxLines: 10,
    },
  },
];

// ============================================================================
// RUBY
// ============================================================================

const rubyFilters: FilterRule[] = [
  {
    name: 'rspec',
    description: 'Strip RSpec noise, keep failures',
    matchCommand: '\\b(rspec|bundle exec rspec)\\b',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^Coverage report', '^SimpleCov', '^Spring is', '^\\.+$'],
      maxLines: 60,
      onEmpty: 'rspec: all passed',
    },
  },
  {
    name: 'rubocop',
    description: 'Strip RuboCop noise',
    matchCommand: '\\b(rubocop|bundle exec rubocop)\\b',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^Inspecting', '^\\.$'],
      maxLines: 50,
    },
  },
  {
    name: 'rake',
    description: 'Strip rake task noise',
    matchCommand: '\\brake\\b',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^\\*\\*'],
      maxLines: 40,
    },
  },
];

// ============================================================================
// .NET
// ============================================================================

const dotnetFilters: FilterRule[] = [
  {
    name: 'dotnet-build',
    description: 'Strip .NET build banners',
    matchCommand: '\\bdotnet\\s+build\\b',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^Microsoft \\(R\\)', '^Copyright \\(C\\)'],
      maxLines: 40,
      onEmpty: 'dotnet build: ok',
    },
  },
  {
    name: 'dotnet-test',
    description: 'Strip .NET test noise',
    matchCommand: '\\bdotnet\\s+test\\b',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^Microsoft \\(R\\)', '^Copyright \\(C\\)', '^Starting test'],
      maxLines: 50,
    },
  },
  {
    name: 'dotnet-run',
    description: 'Strip .NET run noise',
    matchCommand: '\\bdotnet\\s+run\\b',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^Building\\.\\.\\.'],
      maxLines: 40,
    },
  },
]

// ============================================================================
// COMBINED EXPORT
// ============================================================================

export const BUILTIN_FILTERS: FilterRule[] = [
  ...gitFilters,
  ...linterFilters,
  ...testingFilters,
  ...packageManagerFilters,
  ...dockerFilters,
  ...githubFilters,
  ...kubernetesFilters,
  ...cloudFilters,
  ...networkFilters,
  ...rubyFilters,
  ...dotnetFilters,
  ...miscFilters,
];

// Pre-compile all regexes at module load time
for (const rule of BUILTIN_FILTERS) {
  rule._compiled = {
    matchCommand: new RegExp(rule.matchCommand, 'i'),
    matchOutput: rule.matchOutput ? new RegExp(rule.matchOutput, 'i') : undefined,
    replace: rule.pipeline.replace?.map(([pat, rep]) => [new RegExp(pat, 'gm'), rep] as [RegExp, string]),
    stripLines: rule.pipeline.stripLines?.map(pat => new RegExp(pat)),
    keepLines: rule.pipeline.keepLines?.map(pat => new RegExp(pat)),
  };
}
