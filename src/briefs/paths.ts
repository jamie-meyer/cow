// Which changed files decide whether a job's checks pass: its tests, and the
// configuration of continuous integration, linting, formatting, type checking
// and test running. A brief whose diff touches them gets a dispute that needs
// no model. The rules read paths only, never contents. Pure, so each rule can
// be tested; docs/reference.md lists them.

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  /** The path now, relative to the checkout's top; for a deleted file, the path it had. */
  path: string;
  status: FileStatus;
  /** For a renamed file: the path it had at the base. */
  from: string | null;
  /** Not known to git: never added. Its status is "added". */
  untracked: boolean;
}

const base = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const dirs = (path: string): string[] => path.split("/").slice(0, -1);

/** Folders whose files are tests or what tests read. */
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e", "__snapshots__", "testdata", "test-data", "fixtures", "__fixtures__", "__mocks__"]);
/** File names that are tests wherever they are. */
const TEST_NAMES: readonly RegExp[] = [
  /\.(test|spec)\.[^/]+$/i, // a.test.ts, a.spec.js, a.test.tsx
  /_test\.(go|py|rb|exs?|dart|c|cc|cpp)$/i, // a_test.go, a_test.py
  /^test_[^/]+\.py$/i, // test_a.py
  /_spec\.rb$/i, // a_spec.rb
  /(Test|Tests|Spec|IT)\.(java|kt|scala|cs|swift|php)$/, // ATest.java, ATests.swift
  /\.snap$/i, // a snapshot
  /^conftest\.py$/i,
];

/** Is this path a test, or a file the tests read (snapshots, fixtures, test data)? */
export function isTestFile(path: string): boolean {
  if (dirs(path).some((dir) => TEST_DIRS.has(dir.toLowerCase()))) return true;
  const name = base(path);
  return TEST_NAMES.some((rule) => rule.test(name));
}

/** Folders whose every file is continuous-integration configuration. */
const GATE_DIRS: readonly string[] = [".github/workflows/", ".circleci/", ".buildkite/", ".husky/", ".gitlab/ci/"];
/** File names, wherever they are, that configure CI, a linter, a formatter, a type checker or a test runner. */
const GATE_NAMES: readonly RegExp[] = [
  // continuous integration and the hooks that run before a commit
  /^\.gitlab-ci\.ya?ml$/,
  /^\.travis\.ya?ml$/,
  /^azure-pipelines\.ya?ml$/,
  /^bitbucket-pipelines\.ya?ml$/,
  /^\.drone\.ya?ml$/,
  /^Jenkinsfile$/,
  /^\.pre-commit-config\.ya?ml$/,
  /^\.?lefthook\.ya?ml$/,
  // linters
  /^\.eslintrc(\.[a-z]+)?$/,
  /^eslint\.config\.[cm]?[jt]s$/,
  /^\.eslintignore$/,
  /^\.stylelintrc(\.[a-z]+)?$/,
  /^stylelint\.config\.[cm]?js$/,
  /^biome\.jsonc?$/,
  /^\.oxlintrc\.json$/,
  /^\.?ruff\.toml$/,
  /^\.flake8$/,
  /^\.pylintrc$/,
  /^pylintrc$/,
  /^\.golangci\.(ya?ml|toml|json)$/,
  /^\.rubocop\.ya?ml$/,
  /^\.?clippy\.toml$/,
  /^\.markdownlint(\.[a-z]+|rc)?$/,
  /^\.shellcheckrc$/,
  /^\.swiftlint\.ya?ml$/,
  // formatters
  /^\.prettierrc(\.[a-z]+)?$/,
  /^prettier\.config\.[cm]?[jt]s$/,
  /^\.prettierignore$/,
  /^\.editorconfig$/,
  /^\.?rustfmt\.toml$/,
  /^\.clang-format$/,
  /^dprint\.jsonc?$/,
  /^\.swift-format$/,
  // type checkers
  /^tsconfig(\.[^/]+)?\.json$/,
  /^jsconfig(\.[^/]+)?\.json$/,
  /^\.?mypy\.ini$/,
  /^pyrightconfig\.json$/,
  /^\.flowconfig$/,
  // test runners
  /^jest\.config\.[cm]?[jt]s(on)?$/,
  /^vitest\.(config|workspace)\.[cm]?[jt]s$/,
  /^playwright\.config\.[cm]?[jt]s$/,
  /^cypress\.config\.[cm]?[jt]s$/,
  /^karma\.conf\.[cm]?js$/,
  /^\.mocharc(\.[a-z]+)?$/,
  /^\.c8rc(\.json)?$/,
  /^\.nycrc(\.[a-z]+)?$/,
  /^pytest\.ini$/,
  /^tox\.ini$/,
  /^noxfile\.py$/,
  /^phpunit\.xml(\.dist)?$/,
];

/** Does this path configure CI, a linter, a formatter, a type checker or a test runner? */
export function isGateConfig(path: string): boolean {
  if (GATE_DIRS.some((dir) => path.startsWith(dir) || path.includes(`/${dir}`))) return true;
  const name = base(path);
  return GATE_NAMES.some((rule) => rule.test(name));
}

/** Lock files: the diff shows them by name only. */
const LOCK_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "deno.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "pdm.lock",
  "composer.lock",
  "go.sum",
  "mix.lock",
  "pubspec.lock",
  "Podfile.lock",
  "Package.resolved",
  "flake.lock",
  "gradle.lockfile",
  "packages.lock.json",
]);

export function isLockFile(path: string): boolean {
  return LOCK_NAMES.has(base(path));
}

/**
 * The files that changed what decides whether a job's checks pass: a test
 * file that existed at the base and was modified, deleted or renamed, and any
 * change at all to a gate's configuration. A test file that is new is not one.
 */
export function gateChanges(files: readonly ChangedFile[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const was = file.status === "renamed" ? (file.from ?? file.path) : file.path;
    const existingTest = file.status !== "added" && isTestFile(was);
    const config = isGateConfig(file.path) || (file.from !== null && isGateConfig(file.from));
    if (existingTest || config) out.push(file.status === "renamed" && file.from !== null ? `${file.from} → ${file.path}` : file.path);
  }
  return out;
}
