# Copy-on-write workspaces

cow can start a thread in a fast copy of a whole workspace instead of a git
worktree. The copy is assembled from one **workspace folder**, which holds
rules and notes and no projects, and the **repositories** the thread needs,
which live beside it. The thread's working directory is a clone of the
workspace folder with a clone of each repository inside it under the name you
give, so one thread can work across several repositories with all of the
context at hand.

The clones are APFS copy-on-write clones made with `clonefile(2)`: a clone of
a tree of 30,000 entries takes about half a second and uses no extra space
until something in it changes.

## macOS and APFS only

Clones need macOS, and the source folders and cow's own data folder
(`~/.bb/plugins/cow/host-data/`) on the same APFS volume. Anywhere else the
thread fails to start with a message that names both volumes. Nothing is ever
copied instead: a full copy of a large workspace would be slow and would fill
the disk without saying so.

## Starting a thread in one

The provider's id is the plugin's id followed by `-clone`, so for cow it is
`cow-clone` (`bb environment providers` lists it).

```sh
bb thread spawn --project <project id> \
  --environment-provider cow-clone \
  --environment-inputs '{
    "source": "/Users/me/work/workspace",
    "bring": [
      { "path": "/Users/me/work/api", "as": "api" },
      { "path": "/Users/me/work/web", "as": "web" }
    ],
    "readOnly": ["notes"],
    "exclude": ["*.sqlite"]
  }' \
  --prompt "…"
```

The inputs:

| Input | Meaning |
| --- | --- |
| `source` | Absolute path of the workspace folder. Required. |
| `bring` | Repositories to clone into the workspace: `path` is absolute, `as` is the folder name it gets inside the clone. |
| `readOnly` | Paths relative to the clone that lose write permission after cloning. |
| `exclude` | Glob patterns never cloned, added to the default list. |
| `includeSecrets` | `true` drops the default list (the caller's `exclude` still applies). Default `false`. |

`as` must be one plain folder name: no slashes, not `.` or `..`, not already
an entry of the workspace folder, and different from every other `as` (macOS
folder names ignore case). Anything else is refused before anything is
cloned.

The thread runs in `~/.bb/plugins/cow/host-data/clones/<key>/<name of the
workspace folder>`.

## What happens

1. **Checks, before anything is cloned.** The inputs are validated. The
   workspace folder and every brought folder must be real directories (a
   symlink is not followed) on the same volume as cow's data folder. A
   repository whose `.git` is a file (a linked worktree) or that borrows
   objects through `.git/objects/info/alternates` is refused: a clone of it
   would share the original's repository, so a commit in the clone would move
   the original's branch.
2. **Cloning.** The workspace folder is cloned, then each repository into
   `<clone>/<as>`. Large trees are cloned in chunks of at most 5,000 entries,
   so other programs' file renames on the volume never wait more than a few
   tens of milliseconds (one call for the whole tree would hold them for as
   long as it runs). Symlinks are cloned as links, never followed.
3. **Left out.** Anything matching an exclude pattern never exists in the
   clone, even for a moment. The default list is `.env`, `.env.*`, `*.pem`,
   `*.key`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.aws`, `.ssh`, `*.sock`,
   `*.socket` and `*.pid`. A pattern without a slash matches a name at any
   depth; with a slash it matches the path from the top of each cloned
   folder; `*`, `?` and `**` work as in ignore files; a trailing `/` matches
   directories only. Sockets, FIFOs and devices are always left out.
4. **Git, in the workspace folder (if it is a repository) and in each brought
   repository.** Held lock files (`.git/*.lock` and under `.git/refs`) are
   removed; the source's list of linked worktrees (`.git/worktrees`) is
   removed, since it is stale in the clone and `git worktree remove` there
   could delete a real worktree; and a branch named for the thread is created
   from the source's HEAD and checked out. Uncommitted, staged and untracked
   changes come along and stay in place. Git hooks do not run.
5. **Read-only.** Each `readOnly` path loses write permission for everyone,
   recursively. Notes are context for the thread, a snapshot it must not
   edit: what it wrote there would be lost with the clone.
6. **The record.** bb keeps, privately, the source and each repository with
   its path, its HEAD and whether it had uncommitted changes; the branch;
   counts and timing; and warnings, which are also shown in the thread's
   environment log:
   - a Python virtualenv (`pyvenv.cfg`): its scripts name the source's
     absolute paths, so `pip` in the clone would install into the source;
   - an absolute symlink that still points into a source;
   - hard-linked files, which become separate files in the clone.

All or nothing: if any step fails, what was made is removed and the thread's
error names the step and the reason.

## Getting the work back

For now, by hand. A thread's commits are on its branch in the clone; from the
original repository:

```sh
git fetch ~/.bb/plugins/cow/host-data/clones/<key>/<workspace>/<as> <branch>
git log FETCH_HEAD
```

and merge, rebase or cherry-pick from `FETCH_HEAD`. A command for this comes
later. Fetch before the thread's environment is removed: uncommitted work in
a clone goes with it.

## When the clone is removed

bb removes the clone when the last thread using it is archived or deleted,
after a grace window of five minutes. `bb environment cleanup <environment
id>` removes it at once. A removed clone cannot be restored: the provider has
no restore, so bb never rebuilds it, and its threads report the environment
as unavailable.

Removal deletes a directory tree from a process with no sandbox, so it is
exact:

- It is told only the environment's key. No path is ever taken from the
  inputs, from the record, or from anything the thread could have written.
  The key must be one plain path segment, so `..` and slashes are refused.
- The folder to delete is `<clones folder>/<key>`, and both are resolved to
  their real paths: unless the first is strictly inside the second at exactly
  that name, removal is refused. A symlink in its place is refused, not
  followed.
- Processes whose working directory is inside the clone are stopped (SIGTERM,
  then SIGKILL after two seconds).
- Write permission is given back on its directories (the read-only paths),
  without following symlinks, and it is renamed into a trash folder beside
  the clones folder, which is instant; the trash is deleted in the
  background, and symlinks in it are unlinked, never followed. Leftover trash
  is emptied when cow's host process next starts.
- Removing a key that has no folder succeeds.

## Not handled yet

- Virtualenvs are only reported, not fixed.
- No restore: once removed, a clone is gone.
- cow keeps no list of your repositories; each thread names what to bring.
- No command yet to bring a thread's branch back to the originals.
- The inputs have no form in bb's New Thread picker yet; start threads from
  `bb thread spawn`.
- A file the thread marks immutable (`chflags uchg`) would stop removal.
