// What cow was built and tested against, in one place: the page, the README
// and a test all read it from here.

/** The one combination cow has been run on. Anything else may work; none of it has been tried. */
export const TESTED = {
  /** bb releases cow has been run on: this one, and no other. */
  bb: "0.49.0",
  /** The Plugin SDK version cow is compiled against. */
  pluginSdk: "0.6.132",
  /** The agent provider the fixtures and the checker ran on. */
  provider: "Claude Code",
  /** The operating system bb's server and the browser ran on. */
  os: "macOS",
} as const;

/**
 * Every experimental surface of the Plugin SDK that cow uses. bb may change or
 * remove any of these in any release, so these are what to look at first when
 * cow breaks on a newer bb. A test fails when the code and this list differ.
 */
export const EXPERIMENTAL_SURFACES: readonly { name: string; from: "backend" | "page"; for: string }[] = [
  { name: "experimental_PluginRpcRefusal", from: "backend", for: "a refusal that reaches the page and the CLI with its reason" },
  { name: "experimental_dataDir", from: "backend", for: "where bb keeps its data: the reset file's place, and a place no capability may cover" },
  { name: "experimental_listAncestors", from: "backend", for: "which threads are above a thread: who may act for whom, and which capabilities apply" },
  { name: "experimental_listPluginMetadata", from: "backend", for: "finding cow's notes on threads that bb has since deleted" },
  { name: "experimental_schema", from: "backend", for: "the checkerRuns setting as a number from 1 to 5" },
  { name: "experimental_Diff", from: "page", for: "the reader: a file change drawn as a diff" },
  { name: "experimental_SourceCode", from: "page", for: "the reader: a file drawn with highlighting and line numbers" },
  { name: "experimental_copyToClipboard", from: "page", for: "the reader: copying a path" },
  { name: "experimental_openFilePreview", from: "page", for: "the reader's o: the same file in bb's own panel" },
  { name: "experimental_useAppPanel", from: "page", for: "closing a file tab bb opened on cow's page, to show the file in the reader" },
  { name: "experimental_usePanelTabs", from: "page", for: "seeing that file tab open" },
];

type Outside = "older" | "newer";

function parts(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Whether a bb version is outside what cow was tested on: another minor or
 * major release. A patch release of the tested minor counts as inside. A
 * development build (0.0.0) and a version that cannot be read say nothing.
 */
export function outsideTested(version: string, tested: string = TESTED.bb): Outside | null {
  const have = parts(version);
  const want = parts(tested);
  if (!have || !want || have.every((part) => part === 0)) return null;
  for (const index of [0, 1] as const) {
    if (have[index] !== want[index]) return have[index] < want[index] ? "older" : "newer";
  }
  return null;
}

/** What the page says, once, on a bb outside the tested range. */
export function outsideText(version: string, outside: Outside): string {
  const minor = TESTED.bb.split(".").slice(0, 2).join(".");
  return outside === "newer"
    ? `This is bb ${version}. cow was tested on bb ${minor} and uses parts of bb's plugin interface that bb marks experimental, so something here may not work as described. The README lists them.`
    : `This is bb ${version}. cow was built for bb ${minor} and has not been tried on anything older.`;
}

/** Whether a bb theme id is cow's own theme, under whatever id cow is installed. */
export const isCowTheme = (themeId: string): boolean => /^plugin:[^:]+:cow$/.test(themeId);

/** Dismissed asides are remembered per browser, under this key, as a list of names. */
export const DISMISSED_KEY = "cow:dismissed";

export function parseDismissed(stored: string | null): string[] {
  try {
    const value: unknown = JSON.parse(stored ?? "[]");
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(-40) : [];
  } catch {
    return [];
  }
}

/** Read the dismissed names from this browser; nothing when it has no storage. */
export function readDismissed(): string[] {
  try {
    return parseDismissed(window.localStorage.getItem(DISMISSED_KEY));
  } catch {
    return [];
  }
}

/** Remember one more dismissed name in this browser, and return the list. */
export function rememberDismissed(current: readonly string[], id: string): string[] {
  const next = [...current.filter((other) => other !== id), id].slice(-40);
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
  } catch {
    // Without storage it is dismissed for as long as the page stays open.
  }
  return next;
}

/** The notice that a page's key was enrolled by first use is shown until it is put away, for at most this long. */
export const FIRST_USE_SHOWN_MS = 24 * 3_600_000;
