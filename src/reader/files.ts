// Reading for the reader: where a thread's files are, a file's contents,
// and a file change from a thread's timeline. Everything goes through bb's
// SDK from the page.

import type { useSdk } from "@get-bb/plugin-sdk/app";
import { CUT_ABOVE, type Patch, fileKind, toPatch } from "./kind.ts";
import { type FileRef, type LineRange, type Roots, absoluteIn, normalise, placeFile } from "./link.ts";

type Sdk = ReturnType<typeof useSdk>;

/** What the reader is asked to show. */
export type OpenTarget =
  /** An absolute path, as a chat's link gives it. */
  | { kind: "path"; threadId: string | null; path: string; lines: LineRange | null }
  /** A path under one of a thread's roots, as cow's own links and bb's tabs give it. */
  | { kind: "rooted"; threadId: string | null; environmentId?: string | null; root: "workspace" | "storage"; relPath: string; lines: LineRange | null }
  /** A file change in a thread's timeline. */
  | { kind: "change"; threadId: string; rowId: string; path: string };

export type Loaded =
  | { type: "text"; content: string; sha: string; size: number; cut: boolean }
  | { type: "image"; url: string; sha: string; size: number }
  | { type: "binary"; sha: string; size: number }
  | { type: "diff"; patch: Patch; change: string; note: string };

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** How many pages of a thread's timeline are read to find one change: 40 rows or so each. */
const MAX_TIMELINE_PAGES = 40;

const NO_ROOTS: Roots = { hostId: null, workspace: null, storage: null };

/** Reads files for the reader, remembering where each thread's files are. */
export class FileSource {
  private readonly sdk: Sdk;
  private readonly roots = new Map<string, Promise<Roots>>();

  constructor(sdk: Sdk) {
    this.sdk = sdk;
  }

  /** The workspace, storage folder and machine of a thread. What cannot be read is left unknown. */
  rootsOf(threadId: string | null, environmentId?: string | null): Promise<Roots> {
    if (threadId === null && !environmentId) return Promise.resolve(NO_ROOTS);
    const key = `${threadId ?? ""}|${environmentId ?? ""}`;
    let found = this.roots.get(key);
    if (!found) {
      found = this.readRoots(threadId, environmentId ?? null);
      this.roots.set(key, found);
      // A failed read is not remembered.
      found.catch(() => this.roots.delete(key));
    }
    return found;
  }

  private async readRoots(threadId: string | null, givenEnvironment: string | null): Promise<Roots> {
    const { sdk } = this;
    let environmentId = givenEnvironment;
    let storage: Roots["storage"] = null;
    let hostId: string | null = null;
    if (threadId !== null) {
      const [thread, location] = await Promise.all([
        sdk.threads.list({ threadIds: [threadId], limit: 1, includeHidden: true }).then((page) => record(page[0]), () => null),
        sdk.threads.storageLocation({ threadId }).then(record, () => null),
      ]);
      environmentId ??= text(thread?.environmentId);
      const rootPath = text(location?.storageRootPath);
      if (rootPath) storage = { threadId, rootPath };
      hostId = text(location?.hostId);
    }
    let workspace: Roots["workspace"] = null;
    if (environmentId) {
      const environment = await sdk.environments.get({ environmentId }).then(record, () => null);
      const rootPath = text(environment?.path);
      if (rootPath) workspace = { environmentId, rootPath };
      hostId = text(environment?.hostId) ?? hostId;
    }
    return { hostId, workspace, storage };
  }

  /** Work out which file a target names. Throws when its root cannot be found. */
  async place(target: OpenTarget): Promise<FileRef> {
    const roots = await this.rootsOf(target.threadId, target.kind === "rooted" ? target.environmentId : null);
    if (target.kind !== "rooted") {
      const path = normalise(target.path);
      if (path === null) throw new Error(`“${target.path}” is not an absolute path`);
      return placeFile(path, roots, target.threadId);
    }
    const path = target.relPath.startsWith("/") ? normalise(target.relPath) : absoluteIn(target.root, target.relPath, roots);
    if (path === null) {
      throw new Error(target.root === "workspace" ? "this thread has no workspace cow can read, or the path leaves it" : "this thread's storage cannot be read, or the path leaves it");
    }
    return placeFile(path, roots, target.threadId);
  }

  /** A file's contents as the reader shows them. */
  async read(file: FileRef): Promise<Loaded> {
    const got = await this.sdk.files.read({
      path: file.absPath,
      ...(file.hostId ? { hostId: file.hostId } : {}),
      ...(file.rootPath ? { rootPath: file.rootPath } : {}),
    });
    const size = got.sizeBytes;
    const sha = got.sha256;
    if (fileKind(file.absPath) === "image") {
      const svg = /\.svg$/i.test(file.absPath);
      const type = svg ? "image/svg+xml" : `image/${/\.jpe?g$/i.test(file.absPath) ? "jpeg" : (/\.([a-z0-9]+)$/i.exec(file.absPath)?.[1] ?? "png").toLowerCase().replace("ico", "x-icon")}`;
      const url = got.contentEncoding === "base64" ? `data:${type};base64,${got.content}` : `data:${type};charset=utf-8,${encodeURIComponent(got.content)}`;
      return { type: "image", url, sha, size };
    }
    if (got.contentEncoding !== "utf8") return { type: "binary", sha, size };
    const cut = got.content.length > CUT_ABOVE;
    return { type: "text", content: cut ? got.content.slice(0, got.content.lastIndexOf("\n", CUT_ABOVE) + 1 || CUT_ABOVE) : got.content, sha, size, cut };
  }

  /**
   * The change a timeline row made to a file, as a patch. bb gives a
   * timeline a page at a time, newest first, so older pages are read until
   * the row turns up. Null when it is on none of them.
   */
  async change(threadId: string, rowId: string, relPath: string): Promise<Loaded | null> {
    let found: Record<string, unknown> | null = null;
    const walk = (rows: unknown) => {
      if (!Array.isArray(rows)) return;
      for (const raw of rows) {
        const row = record(raw);
        if (!row || found) continue;
        if (row.id === rowId) found = row;
        else {
          walk(row.children);
          walk(row.childRows);
        }
      }
    };
    let before = null as { beforeAnchorId: string; beforeAnchorSeq: string } | null;
    for (let page = 0; page < MAX_TIMELINE_PAGES && !found; page += 1) {
      const timeline = record(await this.sdk.threads.timeline({ threadId, ...(before ?? {}) }));
      walk(timeline?.rows);
      const older = record(record(timeline?.timelinePage)?.olderCursor);
      const anchorId = text(older?.anchorId);
      if (anchorId === null || typeof older?.anchorSeq !== "number" || anchorId === before?.beforeAnchorId) break;
      before = { beforeAnchorId: anchorId, beforeAnchorSeq: String(older.anchorSeq) };
    }
    const change = record((found as Record<string, unknown> | null)?.change);
    const diff = text(change?.diff);
    if (!change || diff === null) return null;
    return { type: "diff", patch: toPatch(diff, relPath), change: text(change.kind) ?? "change", note: "" };
  }
}
