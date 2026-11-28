cow is for running your work through one long-lived Main thread that hands
jobs to other threads. It gives you one page that shows every thread Main has
started, and lets you deal with all of it from the keyboard.

## What you get

- A line per thread: its state, how long it has been in it, what it is doing
  or waiting on, and what moves it next. Threads with threads under them fold
  as groups.
- A queue of only what waits on you: questions, permission requests,
  permissions bb refused without asking, failures, and replies addressed to
  you.
- One key per verb, in the manner of vim: answer, grant or deny, park with a
  pick-up date, resume, stop, archive with a reason, undo.
- For agents, the `bb cow` command: `bb cow ask` puts a question in front of
  you until you answer it, and `bb cow brief submit` reports a finished job as
  claims with evidence, which a separate checker audits before you read it.
- Other plugins on each line: their badges, a pull request's state for
  example, at the end of a thread's line, and their actions for a thread
  under `.`, drawn and run by those plugins, not by cow.
- Capabilities: named grants that answer bb's permission requests "allow
  once" for the threads you choose, with a log of everything allowed.
- A theme, paper and ink, for the whole of bb.

## How it works

cow reads bb's threads and their event logs and keeps its own notes in bb's
database. What only you may do on the page is signed with a key your browser
holds. It makes no network request of its own. Checking a brief starts a
hidden thread on the provider and model set in cow's settings, or else the
ones the submitting thread ran on; that can be turned off in the plugin's
settings. A copy-on-write workspace runs the commands of a workspace file
you approved on the page, outside bb's sandbox. Besides those, cow starts
only git and a few of macOS's own tools, from its host entry on the machine
a thread's checkout is on.

## Requirements

bb 0.49 or later, which is accepted and not tested. Tested on bb 0.50.1
with the Claude Code provider on macOS. It uses parts of
bb's plugin interface that bb marks experimental, so a newer bb may break
parts of it.
