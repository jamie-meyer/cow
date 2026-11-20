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

Or, from an approved workspace file (see [The workspace file](#the-workspace-file)):

```sh
bb thread spawn --project <project id> \
  --environment-provider cow-clone \
  --environment-inputs '{ "workspace": "/Users/me/work/workspace", "bring": ["api"] }' \
  --prompt "…"
```

`workspace` is the folder; the repositories, read-only paths, excludes and
`includeSecrets` come from the content of its `cow.workspace.json` you last
approved, never from the file on disk or the inputs. `bring` picks a subset
by `as` and defaults to all; a name the approved file does not bring is
refused. A folder whose file was never approved is refused, and says so.
The clone's record keeps the hash of the approved content it was made from.

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

7. **From a workspace file only.** Before cloning, with `syncBeforeClone`,
   each repository whose last successful sync is older than the age is synced
   first; if that sync fails, or the repository has changes, what is there is
   cloned and the failure is a warning in the record and the environment log,
   not a failed thread. After the clone is assembled, each repository's
   `setup` (and the workspace folder's) runs once, before the thread starts.
   A setup that fails fails the thread, with its last lines of output in the
   error, and the clone is removed.

All or nothing: if any step fails, what was made is removed and the thread's
error names the step and the reason.

## The workspace file

A file at the top of the workspace folder, `cow.workspace.json`, says which
repositories a thread brings and how to keep them in sync, set a clone up,
bring a thread's work back, and tear a clone down before it is removed. cow
knows nothing about git or any other tool: `sync`, `setup`, `back` and
`teardown` are shell commands you write.

```json
{
  "bring": [
    { "path": "../api", "as": "api",
      "sync": "git pull --ff-only",
      "setup": "npm install",
      "back": "git -C \"$COW_SOURCE\" fetch \"$COW_CLONE\" \"$COW_BRANCH:$COW_BRANCH\"" }
  ],
  "sync": "git pull --ff-only",
  "readOnly": ["notes"],
  "exclude": [],
  "syncBeforeClone": { "olderThanMinutes": 60 }
}
```

| Field | Meaning |
| --- | --- |
| `bring[].path` | The repository: relative to the workspace folder, or absolute. |
| `bring[].as` | Its folder name in the clone, as for the explicit inputs. |
| `bring[].sync`, `.setup`, `.back`, `.teardown` | Optional commands for that repository. |
| `sync`, `setup`, `back`, `teardown` | Optional commands for the workspace folder itself. |
| `readOnly`, `exclude`, `includeSecrets` | As for the explicit inputs. |
| `syncBeforeClone` | `{ "olderThanMinutes": n }`: sync a repository before cloning it when its last good sync is older. Off when absent. |

The file is read strictly: an unknown field is refused (so a typo is never
silently ignored), and every problem names its field, such as
`bring[0].setpu: unknown field` or `bring[1].as: "api" is used twice`.

**These commands run with your full access, outside any sandbox.** They are
run by cow's host entry, a Node process on your machine with no sandbox, as
you. Treat the file like a shell script you run yourself.

### Nothing in it runs until you approve it

The file sits where agents can write, so cow never runs anything from the
file on disk. It keeps, per workspace folder (by its real path), the last
content you approved, in its own storage, and uses only that.

- `bb cow workspace add <folder>`, from a terminal or a thread, only
  proposes the folder: a notice appears in your queue, "the workspace file
  of <folder> is new and is waiting for you". It approves nothing.
- Opening the notice (a click, or `f` and its hint) shows the file in the
  reader: the commands that would newly run first, then the change as a diff
  of the approved content against the current one (the whole file, for a
  first approval). There `a` approves exactly the content shown: the signed
  call carries its SHA-256, and is refused if the file changed again since
  it was shown. `x` dismisses the notice without approving, until the file
  changes again.
- Every later change to the file brings the notice back. Until you approve
  it, sync, setup, back and teardown keep using the content you approved last; with
  none approved, they refuse and say why (and no teardown runs).
- Every approval is appended to cow's log with the content's hash (`C`,
  `Tab`). Cloning with explicit inputs still works and runs no command.

### How a command runs

Each command runs with `/bin/sh -c`, the approved text unchanged, in a fixed
working directory, under a time limit, with what it needs only as
environment variables. cow never puts a path, a branch or anything else into
the command's text.

| Command | Working directory | Time limit |
| --- | --- | --- |
| `sync` | the source repository (or the workspace folder) | 5 minutes |
| `setup` | the repository's folder in the clone (the clone's root for the workspace folder's own) | 15 minutes |
| `back` | the source repository (or the workspace folder) | 5 minutes |
| `teardown` | the repository's folder in the clone (the clone's root for the workspace folder's own) | 15 minutes |

| Variable | Value |
| --- | --- |
| `COW_SOURCE` | the source repository's real path |
| `COW_CLONE` | its folder in the clone (setup, back and teardown; for a held clone, where it is now) |
| `COW_BRANCH` | the thread's branch (setup, back and teardown) |
| `COW_AS` | the repository's `as`, or `.` for the workspace folder |
| `COW_WORKSPACE` | the workspace folder's real path |

At the time limit the command and everything it started get SIGTERM, then
SIGKILL two seconds later. One command runs at a time per repository. Of
each run cow keeps when it ran, how long it took, its exit code and its last
20 lines of output, in its host data folder only
(`~/.bb/plugins/cow/host-data/workspace/runs.json`, readable by you alone):
not in bb's database and not in the log, since output may hold secrets.
`bb cow workspace` shows the exit code and the time; the output is shown
only to you, in the reader (`W`, then `Enter` on a repository, or on a held
clone for its teardowns), by a signed call.

### Sync

```sh
bb cow workspace sync [<folder>] [--only <as>] [--json]
```

Runs each repository's `sync`, then the workspace folder's own (`--only .`
picks the workspace folder alone; without a folder, every approved
workspace). Before each, the source is checked: a git repository with
uncommitted or untracked changes (`git status --porcelain`) is skipped and
reported, never touched; a folder that is not a git repository is taken as
clean. It exits 1 when a command failed.

Anyone may run sync: it runs only approved commands, with fixed arguments.
So a bb automation can keep the clean bases current, for example a script
automation that runs `bb cow workspace sync` every hour (see `bb guide
automations`). On the page, `W` lists each workspace; `s` syncs the selected
repository and `S` every approved workspace; `Enter` shows the selected
repository's last sync output, to you only (a signed call), and `r` opens
its workspace's file when it has changed since you approved it.

### Bringing work back

```sh
# on cow's page: B on the thread's line brings it back, y confirms
bb cow workspace back <thread> [--json]   # the same plan, shown; runs nothing
```

Bringing work back looks, for each repository in the thread's clone, at the
commits its branch has that its source does not (the branch against the
commit recorded when the clone was made), and runs that repository's `back`
in the source. The approved file used is the one the clone was made from,
or, for a clone made with explicit inputs, the approved file of its source
folder if cow knows it.

This writes outside the thread's sandbox with a command you wrote, so it is
yours alone, and only the page does it: `B` on the thread's line names each
repository with new commits and the command it would run; `y` runs them,
signed by your page's key, and shows what each exited with; any other key
cancels. Each run is added to the log.

`bb cow workspace back <thread>` runs nothing, for anyone. It prints the same
plan, each repository with its new commits and the command that would run,
and says how you bring it back (`--json` gives the plan as JSON):

```
thr_abc123 (branch cow/thr_abc123), workspace ~/work
  api            2 new commits · would run: git -C "$COW_SOURCE" fetch -q "$COW_CLONE" "$COW_BRANCH:$COW_BRANCH" · in ~/work/api
  web            nothing new · nothing to bring back · in ~/work/web
Nothing was run. The user brings it back with B on the thread's line on cow's page.
```

A thread whose work is ready to come back says so with `bb cow ask`, naming
the thread; it cannot run a back command.

### Examples

Plain git: each clean base follows its main branch, and a thread's branch is
fetched into the original as a branch of the same name.

```json
{
  "bring": [
    { "path": "../api", "as": "api",
      "sync": "git fetch -q origin && git merge -q --ff-only origin/main",
      "setup": "npm ci",
      "back": "git -C \"$COW_SOURCE\" fetch -q \"$COW_CLONE\" \"$COW_BRANCH:$COW_BRANCH\"" }
  ],
  "sync": "git pull -q --ff-only"
}
```

A stacking tool: sync with the tool's own command, and bring a branch back
so the tool tracks it. With Graphite, for example:

```json
{
  "bring": [
    { "path": "../web", "as": "web",
      "sync": "gt sync --no-interactive",
      "back": "git -C \"$COW_SOURCE\" fetch -q \"$COW_CLONE\" \"$COW_BRANCH:$COW_BRANCH\" && gt track \"$COW_BRANCH\" --no-interactive" }
  ]
}
```

A setup that gives each clone its own database, and a teardown that commits
what the thread left uncommitted, fetches its branch into the source, and
drops the database:

```json
{
  "bring": [
    { "path": "../api", "as": "api",
      "setup": "createdb \"api_$(basename \"$COW_BRANCH\")\" && npm ci",
      "teardown": "{ git add -A && git commit -qm 'left in the clone' || true; } && git -C \"$COW_SOURCE\" fetch -q \"$COW_CLONE\" \"$COW_BRANCH:$COW_BRANCH\" && dropdb --if-exists \"api_$(basename \"$COW_BRANCH\")\"" }
  ]
}
```

If the fetch fails, the teardown fails and the clone is held, with the
database still there for you to look at.

Check the flags against your tool's own help: cow runs the text as written.

## Getting the work back by hand

Without a back command, a thread's commits are on its branch in the clone;
from the original repository:

```sh
git fetch ~/.bb/plugins/cow/host-data/clones/<key>/<workspace>/<as> <branch>
git log FETCH_HEAD
```

and merge, rebase or cherry-pick from `FETCH_HEAD`. A clone that still holds
work when bb removes it is held rather than deleted (below), and stays where
you can fetch from it.

## When the clone is removed

bb removes the clone when the last thread using it is archived or deleted,
after a grace window of five minutes. `bb environment cleanup <environment
id>` removes it at once. A removed clone cannot be restored: the provider has
no restore, so bb never rebuilds it, and its threads report the environment
as unavailable.

### Teardown, and the unsaved-work check

When bb asks the provider to remove a clone, cow first stops the processes
working in it, then, for a clone made from a workspace file, runs each
repository's `teardown` from the content you approved for that workspace
now (not the file on disk, and not the content the clone was made from):
the brought repositories in the reverse of setup's order, then the workspace
folder's own. A teardown that fails does not stop the others. A clone made
with explicit inputs runs no teardown: setup never ran in it.

Then, for each git repository in the clone without a teardown, cow looks for
work that would be lost:

- anything uncommitted or untracked (`git status --porcelain`; ignored files
  do not count; in the workspace folder, the brought repositories inside it
  are left to their own check);
- commits its source repository does not have: a branch, a stash or a
  detached HEAD whose commit the source has no object for. Work already
  brought back, or pushed and then fetched into the source, does not count.

A folder that is not a git repository cannot be judged and does not hold the
clone. Changes that came along from a dirty source count like any other,
and so does a tracked file the exclude list left out (it reads as deleted).

| Teardown | Unsaved work | The clone |
| --- | --- | --- |
| every one exited 0 | any | removed: a clean teardown is taken as having saved what mattered |
| none for a repository | none in it | removed |
| one failed or ran past its time limit | any | **held** |
| none for a repository | some in it | **held** |

### Held clones

A held clone is moved aside in one rename to
`~/.bb/plugins/cow/host-data/held/<id>/<workspace>`, with why beside it in
`held/<id>.json` (which repository, which reason, teardown's exit code, and
its last lines of output, readable by you alone). bb is told the clone was
removed: had cow failed the removal instead, bb would run teardown again
after 1, 2, 4 and 8 minutes and then mark the environment "Needs recovery".
The environment log says it was held, why, and where.

A notice in your queue says "the clone of <thread> was held, not deleted"
and why; a click or its hint opens `W`, whose "Held clones" part lists each
one with its thread's title, when it was held, why and its path, so you can
look inside or fetch from it. There, on a held clone:

- `Enter` shows what its teardowns printed (signed: output may hold secrets);
- `t` runs the approved teardown again, where the clone is now, and judges
  it as removal does: with nothing left to hold it, it is removed;
- `d` asks to remove it for good, naming what would be lost (each
  repository's uncommitted changes and commits its source does not have);
  `y` removes it, any other key keeps it.

Each is signed by your page's key and added to the log; so is each clone
bb's removal held. `bb cow workspace` lists held clones, without any output,
for anyone; nothing unsigned can remove one or run its teardown. The only
way a teardown runs without your page is bb's own removal of a clone, which
any thread can bring about by being archived: that is why teardown, like
every command, runs only from content you approved.

### Removing exactly

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
- A held clone is removed by the same rules: its id is one plain path
  segment, its folder must resolve to exactly `<held folder>/<id>`, a symlink
  is refused, and it is renamed into the trash before it is deleted.

## Not handled yet

- Virtualenvs are only reported, not fixed.
- No restore: once removed, a clone is gone. A held clone is a folder you
  can look into and fetch from, not an environment a thread can run in again.
- Held clones are listed for the machine bb runs on.
- A thread that fails to start after its setup ran gets no teardown.
- The inputs have no form in bb's New Thread picker yet; start threads from
  `bb thread spawn`.
- A file the thread marks immutable (`chflags uchg`) would stop removal.
