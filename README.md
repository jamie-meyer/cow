# 🐄 cow

cow is a plugin for [bb](https://getbb.app). You run your work through one
long-lived **Main** thread that hands jobs to other threads, and cow gives you
one page that shows every one of them: what state it is in, for how long, what
it is doing, and what moves it next. The page is driven from the keyboard, in
the manner of vim.

## Status

Early. The page shows every thread's state and acts on it: you can answer a
question, grant or deny a permission request, deal with a permission bb
refused without asking, park work and get it back, stop a turn, archive with
a reason, and undo. An agent can leave the same notes with the `bb cow` CLI.
A state comes from what bb knows about a thread plus cow's own notes on it.
Nothing tells cow yet that a thread is waiting on something other than you.

A thread that finishes reports to the thread that started it, so it is that
thread's to deal with: its line turns done and still shows the first line of
what it reported. The queue holds only what is yours: questions, permission
requests, permissions bb refused without asking, failures, replies from Main
that you have not read, and parked work that has come back.

## Install for development

You need bb 0.49 or newer.

```sh
npm install
bb plugin install .   # builds this folder and registers it in your bb
bb plugin dev         # optional: rebuild and reload on every save
```

Open cow from the 🐄 entry in bb's navigation, or go to `/plugins/cow/main`.
The first time, pick the thread that is your Main: `j` / `k` to move, `Enter`
to choose.

Each window keeps its own Main. Choosing a Main in one window does not move
another window that is already open, and a window keeps its Main through a
reload. A new window starts from the Main chosen most recently; `M` changes
it for that window.

## Keys

The page starts in normal mode. Typing in any input works as usual, and
while a prompt is open no key does anything else.

Moving and looking:

| Key | Does |
| --- | --- |
| `j` `k`, arrows | next, previous line |
| `g g`, `G` | first, last line |
| `f` | letter hints on every line and action in view; type one to use it |
| `Enter` | open the line's chat beside the overview; again to type in it |
| `Esc` | leave the chat, then close it; cancel whatever is open |
| `m` | open Main's chat the same way |
| `i` | say something to Main |
| `I` | say something to the selected thread |
| `Tab`, `Shift+Tab` | next, previous entry in the queue |
| `1` to `9` | jump to that place in the queue |
| `M` | choose a different Main for this window |
| `?` | the legend and this key map |

Acting: select a line first, then press the verb. The bar at the bottom shows
which verbs apply to the selected line and greys out the rest; a greyed-out
verb takes no hint, and its key says why it does not apply.

| Key | On | Does |
| --- | --- | --- |
| `a` | a line with a pending question | opens the question under the line: digits choose, `Enter` sends, `Esc` cancels |
| `a` | a line with a permission request | opens the request under the line: digits choose, `Enter` confirms, `Esc` cancels |
| `a` | a line blocked on a permission | opens what bb refused: ask again as you, tell it to carry on, or dismiss |
| `p` | any line that is not parked | parks it: a reason, then a pick-up |
| `p` | parked work that came back | keeps it parked with a new pick-up; the reason stays |
| `r` | a parked line | resumes it: back into the tree |
| `x` | a line whose turn is running | stops the turn, after `y` |
| `x` | parked work that came back | drops it: asks for a reason, then stops and archives it |
| `e` | a done or failed line | asks for a reason, then archives the thread in bb |
| `u` | anywhere | undoes the last park, resume, archive or dismissal, after showing what and `y` |

A confirmation takes `y`; any other key cancels it and does nothing else.

Hints (`f`) give every line a single letter, home row first, and use two
letters only when there are more targets than letters.

When a verb makes a line leave its place (park, resume, archive, drop), the
cursor goes to the next line down that stays, or up when nothing is below.
Undo puts the cursor on the line it brought back. Nothing else moves it.

While the cursor is in the overview, no key reaches the embedded chat, so a
stray digit cannot answer a question there. Keys with Cmd, Ctrl or Alt are
left to bb. "🐄 cow: choose the Main thread" is also in bb's command palette
while the page is open.

## Answering

`a` shows the question with its options numbered, and a text field when the
question takes an answer in your own words. Choosing and sending are always
two steps: a digit only marks an option, and `Enter` sends. A question with
several parts is answered one part at a time and sent at the end. The line
leaves the queue when bb reports the question resolved.

cow answers the agent's built-in questions. A form that belongs to another
plugin is shown with what it is about, and `Enter` opens the thread's chat,
where it can be answered.

## Permission requests

When an agent wants to do something bb did not approve by itself, the thread
waits on a permission request. cow shows it as its own kind of ask: the line
and the queue entry say "permission to run: …" or "permission to change a
file in …", and the next move reads "grant or deny: press a".

`a` opens the request under the line with everything bb provides: the exact
command and its working directory, or the file and its diff, and bb's reason
for asking. Under that are the decisions bb offers, numbered:

| Decision | Does |
| --- | --- |
| Allow once | this command or this change, this time |
| Allow for the rest of this session | offered when bb offers it; wider than the one request |
| Deny | the agent is told no, and carries on with its turn |
| Deny, and tell it why | a denial, then the text you type, sent to the thread as a message |

Granting is deliberate. A digit only marks a decision and `Enter` confirms
it, so no single key grants anything. "Allow for the rest of this session"
needs a second `Enter`, after cow has named exactly what it grants (the
directories it may read and write, the network, commands like this one);
`Esc` there goes back to the choices. Denying with a message needs the
message.

No decision can be undone. Once allowed, the command runs or the file is
written at once, and a session grant lasts until the thread's session ends.
The card says so.

Two limits come from bb, not from cow:

- bb asks only when the turn was started by a person. When another agent
  started the turn (Main telling a thread to do something, for example), bb
  refuses what would need permission and tells the agent so; no request is
  raised. cow finds those refusals itself: see "Blocked on a permission".
- bb's denial carries no text. "Deny, and tell it why" is a denial followed
  by a normal message to the thread.

cow answers requests to run a command and to change a file. A plan to
approve, or a request to use some other tool, is described on the card, and
`Enter` opens the thread's chat to answer it there.

## Blocked on a permission

Under cow most turns are started by Main, not by you. bb raises a permission
request only on a turn a person started; on any other turn it refuses the
action by itself, tells the agent no, and shows you nothing. The work is then
blocked on a permission you were never asked for.

cow reads each thread's event log for those refusals. A thread that has one
gets a state of its own, **blocked on a permission** (⊘). Its line and its
queue entry say what was refused, "bb refused to run: …" or "bb refused to
change /path", with "(and 2 more)" when there are several.

`a` opens the refusal under the line: each refused command or file change in
full (the command, or the file and its diff), what bb told the agent, and
three choices, numbered. A digit marks one and `Enter` carries it out.

| Choice | Does |
| --- | --- |
| Ask again as me | sends the thread a message, as you, telling it to do exactly that again |
| Tell it to carry on without it | sends a message, as you, saying the permission will not be granted and to go another way or report back |
| Dismiss | clears the blocked state and tells the thread nothing; `u` undoes it |

**Ask again as me** is the way to grant what bb refused. cow cannot approve a
refusal after the fact, because bb raised no request to approve. But a
message sent as you starts a turn that a person started, so when the agent
tries the same action again bb does ask. That request appears on the line
like any other ("permission to run: …"), and `a` opens the ordinary
permission card to allow or deny it. So it is two steps on purpose: ask
again, then grant.

Both messages are shown on the card before anything is sent. `e` puts the
caret in the message to edit it (`Shift+Enter` for a new line, `Esc` back to
the choices); `Enter` sends it. A sent message cannot be undone.

A refusal stops counting, and the line leaves this state, when any of these
happens:

- you send the thread a message (either choice above, or `I`);
- the same command runs, or the same file is changed, successfully later in
  that turn;
- the thread starts a new turn, whoever started it: whoever runs the thread
  has moved it on;
- you dismiss it, or the thread is archived.

So a refusal the agent worked around stays on the page only until that
thread's next turn, and never longer than you let it: dismiss it. The cost of
this rule is that a thread nudged by Main while still blocked stops reading
as blocked unless bb refuses it again.

What cow recognises is what bb does today with the Claude Code provider: a
command or file change that failed without an approval, on a prompt not sent
by you, with one of the messages bb refuses with. bb marks a refusal in no
other way. A denial you made yourself is never shown as a refusal. cow reads
the latest hundred or so events of a thread, so a refusal further back than
that in a very long turn is not seen. Refused tools other than the shell and
file edits are not detected.

## Parking

Parking is for work that stalls: it should stop reading as stuck, and it must
not be forgotten. `p` asks for a reason (required) and then for a pick-up:

| You type | Means |
| --- | --- |
| `19 Nov`, `Nov 19`, `19 Nov 2027`, `2027-11-19` | the start of that day; with no year, the next time it comes |
| `+3d`, `+2w` | that many days or weeks from now |
| anything else | a condition in your own words |
| nothing | no pick-up |

Something that looks like a date or a time but is not a valid one is
rejected; cow never guesses a date. The day has to be after today.

Parking is a note cow keeps on the thread (in its plugin metadata). It does
not message or change the agent, with one exception: if the thread's turn is
running, cow asks "stop it and park?" and stops the turn on `y`.

A parked line leaves the tree for the **Parked** shelf, a section that is
always on the page. Each line there shows the name, the reason, how long it
has been parked (one square per full week) and its pick-up. Threads under a
parked thread go with it and are counted on its line.

Parked work comes back by itself, as an entry in the queue:

- when its date arrives; or
- with no date, every four weeks: "still parked for N weeks: keep, resume,
  or drop?". cow cannot detect a condition written in words, so it shows the
  condition and asks every four weeks as well.

On work that came back, `r` resumes it, `p` keeps it parked with a new
pick-up, and `x` drops it. Resuming only removes the note: the line returns
to the tree in whatever state bb gives it, and the agent is told nothing.
`I` says something to it if you want it to carry on.

## Archiving, with a reason

`e` on a done or failed line asks why, on one line. `Enter` archives; on an
empty line it archives without a reason. `Esc` cancels. Dropping parked work
that came back (`x`) asks the same way before it stops and archives it.

The reason is cow's note on the thread. It shows on the thread's line under
Done ("archived: …"). If you undo the archive the note stays on the thread,
so archiving it again offers the same reason; clear the line to archive
without one.

## Undo

`u` takes back the last park, resume, archive (it unarchives), or dismissal
of a refused permission, then the one before, for as long as the page stays
open. Four things cannot be undone, and they say so: stopping a turn,
answering a question, deciding a permission request, and sending a message.
Undoing a park that stopped a turn, or a drop, restores the line but the turn
stays stopped. bb archives the threads under a thread along with it; undo
brings those back too.

## Theme

cow's page draws with bb's own theme: its background, ink, borders, accent
and fonts are bb's theme tokens. So the page matches the chat beside it, and
the rest of bb, in whichever theme you run, light or dark.

cow's own look, warm paper and dark ink set in a serif, ships as a bb theme
named **cow**. It is not turned on for you, because a bb theme applies to the
whole app and every open window. Turn it on in Settings → Appearance, or:

```sh
bb theme set plugin:cow:cow   # paper and ink everywhere, light and dark
bb theme reset                # back to bb's default
```

Light or dark follows bb's own setting. The theme also picks code colours
for code blocks and diffs (Vitesse, light and dark). It leaves the terminal's
colours and font alone.

## States

| Mark | State | Means |
| --- | --- | --- |
| ● | wants you | it asked you a question or for permission, or Main finished with a reply you have not read |
| ⊘ | blocked on a permission | bb refused it a command or a file change without asking you; `a` asks again as you |
| ▶ | running | a turn is in progress |
| ◆ | stuck | running with no event for 2 hours, or waiting on you for 7 days |
| ‖ | parked | you set it aside with `p`; it is on the shelf until it comes back |
| ✕ | failed | its last turn ended in an error; stays in the queue |
| ✓ | done | finished, or archived, in the last 2 days; older ones are only counted |

The limits live in one place, `LIMITS` in `src/state.ts`.

## The CLI, for agents

Main is an agent, and it cleans up after the threads it started. `bb cow`
gives it the page's verbs, so its clean-up carries a reason the way yours
does. The commands follow the page's rules and act through the same backend
code, and the page shows what they change at once.

```sh
bb cow status [--main <thread>] [--json]
bb cow archive <thread> [--reason <text>]
bb cow park <thread> --reason <text> [--pickup <date|+3d|+2w|text>] [--stop]
bb cow resume <thread>
bb cow help
```

| Command | Does |
| --- | --- |
| `status` | the overview as text: the queue, then one line per thread with its state, time in state, and what it is doing or waiting on, then the parked shelf and what finished in the last 2 days |
| `archive` | archives a done or failed thread in bb and records the reason; refused while threads under it are still open |
| `park` | sets a thread aside; the reason is required, and `--pickup` is read exactly as the page reads a pick-up |
| `resume` | takes a parked thread off the shelf |

`status` uses the Main last chosen on the page for the project the command
runs in, unless `--main` names one. Its output is bounded: at most 80 open
threads, 30 parked, 20 done and 20 queue entries are listed, and the rest are
counted. `park` refuses a thread whose turn is running unless `--stop` is
given, which stops the turn first, as the page does after asking. A refused
command exits non-zero and says why; every command takes `--json`.

The CLI has no undo: `bb cow resume` reverses a park, and
`bb thread unarchive` reverses an archive. Answering questions, granting
permissions and dealing with refused ones stay with you, on the page.

The plugin ships a skill, `skills/cow/SKILL.md`, that tells agents about
these commands.

## Develop

```sh
npm test            # unit tests: states, refused permissions, parking, pick-up dates, verbs, answers, permission requests, the CLI, hints
npm run typecheck
```

`npm run e2e` drives the real page in a separate headless Chrome. It creates
six cheap fixture threads titled "cow test", acts only on those (it answers,
stops and archives them for real, grants them permission to run `echo` and to
write one file under `/tmp`, and runs `bb cow` on them), and archives them
afterwards. See the top of `scripts/e2e.mjs` for how to run it.

## Turn it off

```sh
bb plugin disable cow   # unload it; your choice of Main is kept
bb plugin remove cow    # uninstall it and delete what it stored
```

cow stores three things: which thread was last chosen as Main for each
project; its notes on a thread (why it is parked, why it was archived, which
refused permissions you dismissed), kept in that thread's plugin metadata;
and, in each window's session storage, the Main that window shows.

## License

MIT
