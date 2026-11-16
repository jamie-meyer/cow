---
name: cow
description: Record why a thread is parked or archived, resume parked work, say what is next for your thread, and read the overview of every thread under Main, with the `bb cow` CLI. Use when cleaning up or setting aside threads you started, when you end a turn with work still planned, or when asked what is waiting on the user.
---

# cow: notes on the threads you started

cow is the user's overview page for one long-lived Main thread and every
thread it has started. The user parks and archives threads there with a
reason. `bb cow` lets you leave the same notes, under the same rules, so your
clean-up shows on their page with its "why".

Use these instead of `bb thread archive` when you clean up after a thread you
started: the reason is what the user reads later.

## Commands

```sh
bb cow status [--main <thread>] [--json]
bb cow archive <thread> [--reason <text>]
bb cow park <thread> --reason <text> [--pickup <date|+3d|+2w|text>] [--stop]
bb cow resume <thread>
bb cow next <thread> "<text>" | --clear
bb cow todo add <thread> "<title>"
bb cow todo done <thread> <n>
bb cow todo rm <thread> <n>
bb cow todo list <thread>
bb cow help
```

Every command takes `--json` and `--help`. A refused command exits non-zero
and says why; with `--json` the error is `{"ok": false, "error": {...}}`.

### `bb cow status`

One line per thread under Main: place in the user's queue (if any), state,
time in that state, title and id, what it is doing or waiting on, and what
moves it next. Then the Parked shelf and what finished in the last 2 days.

- Main defaults to the one last chosen on cow's page for the project you are
  in. Pass `--main <thread>` (your own id is in `$BB_THREAD_ID`) when that is
  not the one you mean.
- States: `wants` (it asked the user something, or it finished with a reply
  addressed to the user that they have not seen: a thread with threads
  under it, or one the user messaged), `blocked` (bb refused it
  a command or file change without asking; only the user can unblock it,
  from cow's page), `running`, `stuck`, `parked`, `failed`, `done`.
- Output is bounded: at most 80 open threads, 30 parked, 20 done and 20 queue
  entries; the rest are counted.

### `bb cow archive <thread> [--reason <text>]`

Archives the thread in bb, recording why. Refused unless the thread is done
or failed (or blocked on a permission with no turn running), and refused
while threads under it are still open: archive or park those first. bb
archives the threads under it along with it.

### `bb cow park <thread> --reason <text> [--pickup …]`

Sets work aside without losing it. The reason is required. `--pickup` is when
it should come back to the user's queue:

| `--pickup` | Means |
| --- | --- |
| `19 Nov`, `Nov 19`, `2027-11-19` | the start of that day; it must be after today |
| `+3d`, `+2w` | that many days or weeks from now |
| any other text | a condition in words; the user is asked every 4 weeks |
| omitted | no pick-up; the user is asked every 4 weeks |

Something shaped like a date that is not a valid one is rejected, never
guessed. Parking does not message the thread. A thread whose turn is running
is refused unless you add `--stop`, which stops the turn first and cannot be
undone. Main itself cannot be parked or archived.

### `bb cow resume <thread>`

Removes the park note. The thread goes back into the tree in whatever state
bb gives it; it is told nothing, so message it if it should carry on.

## Saying what is next

The user's page shows what exists, not what you intend. A thread that has
finished one piece of work and not started the next looks finished unless
it says otherwise. Your own id is in `$BB_THREAD_ID`.

- **`bb cow next <thread> "<text>"`**: one line, up to 160 characters, of
  what happens next for the thread. Set it whenever you end a turn with
  work still planned. Clear it with `--clear` when nothing is planned.
- **`bb cow todo add <thread> "<title>"`**: work not started yet, shown in
  order inside the thread's group. Keep the list to the next few items (it
  holds 12). When you start or finish an item, `bb cow todo done <thread>
  <n>`; when it will not be done, `bb cow todo rm <thread> <n>`. `<n>` is
  the item's number in `bb cow todo list <thread>`, counted from 1.

You may set these only on your own thread and on the threads under it;
anything else is refused. The user can remove and reorder the items from
the page. `bb cow status` shows each thread's note and list.

## Limits

- Only the user can answer a question, grant a permission, deal with a
  refused permission, or mark a reply as seen; those are done on cow's page.
- There is no undo from the CLI. `bb cow resume` reverses a park;
  `bb thread unarchive <thread>` reverses an archive (the reason is kept).
