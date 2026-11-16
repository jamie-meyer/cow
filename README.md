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
a reason, and undo. A thread with threads under it is drawn as a group that
folds. An agent can leave the same notes with the `bb cow` CLI, and say what
is next for it. A state comes from what bb knows about a thread plus cow's
own notes on it. Nothing tells cow yet that a thread is waiting on something
other than you.

A worker that finishes reports to the thread that started it, so it is that
thread's to deal with: its line turns done and still shows the first line of
what it reported. A thread you talk to yourself replies to you: see
"Replies addressed to you". The queue holds only what is yours: questions,
permission requests, permissions bb refused without asking, failures,
replies addressed to you that you have not seen, and parked work that has
come back.

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
| `j` `k`, arrows | next, previous line; the heading (Main) is the stop above the first line |
| `g g`, `G` | the heading, the last line |
| `/` | filter the lines: see "Filtering" |
| `h`, `l`, left and right arrows | fold, unfold a group; on a member, `h` goes to its group's head |
| `f` | letter hints on every line, action, link and button in view; type one to use it |
| `Enter` | open the line's chat beside the overview, or switch the pane to it; it never types into the chat |
| `Esc` | leave the chat, then close it; cancel whatever is open |
| `m` | open Main's chat the same way |
| `i` | type in the chat that is open, wherever the cursor is: the only key that does; with no chat open, say something to Main |
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
| `Space` | a line that replied to you | marks the reply as seen: the line stops waiting on you |
| `x` | a not-started item | removes it from its thread's list, after `y` |
| `J`, `K` | a not-started item | moves it down, up its list |
| `u` | anywhere | undoes the last park, resume, archive, dismissal or mark as seen, after showing what and `y` |

A confirmation takes `y`; any other key cancels it and does nothing else.

Hints (`f`) label everything on the page that a click or a caret can use:
cow's lines and actions, and inside the chat pane its links, buttons, menus,
disclosure toggles, copy buttons, file links and the composer. cow's own
lines are labelled first, home row first, so their letters stay short and do
not change with what the chat shows; two letters are used only when there
are more targets than letters. A hint acts as a click of the mouse would: a
link opens the way it does when clicked, and a field takes the caret. When
that opens a menu or a dialog of bb's, press `f` again: the hints are then
on what it offers, and on nothing else. Only things in view take a hint;
scroll the chat to reach the rest. In a bb menu `f` is cow's, so it cannot
be used there to jump to an entry by its first letter.

## Filtering

`/` opens a small input in the status line. As you type, the page narrows
to the lines that match, in the manner of a fuzzy finder. A line matches
when every word you typed is found in it: loosely in its name (the word's
letters in order, with anything between them, so `sso cut` finds "SSO
cutover"), or exactly in what the line says it is doing. Case never matters.
Parked and done lines and not-started items are searched too.

Matches stay in the page's order instead of being ranked, because ranking
would pull a line away from its group. The head of a group that holds a
match stays on the page, dimmed, so the match keeps its context, and a
match inside a folded group is shown. While the input is open every letter
is text, `j` and `k` included: `Ctrl+n`, `Ctrl+p` and the arrows move among
the matches. `Enter` closes the filter with the cursor on the chosen line
and the whole list back, unfolding only what would hide that line. `Esc`
cancels: the cursor and the folds are as they were.

## Groups

Any thread that has threads under it is a group: there is nothing to mark.
Its line is the head, in bold with a fold mark (▾), and its members are
listed under it along one continuous rule, so what belongs to what reads at
a glance. Groups nest, one rule per level.

The head's line carries a rollup of everything under it, at every level:
how many want you, are blocked, stuck, failed, running, parked and done,
with the same marks as the lines.

`h` on a head folds the group and `l` unfolds it. On a member, `h` jumps to
its group's head; on an unfolded head, `l` steps onto its first member.
`j` and `k` skip the members of a folded group. A folded head (▸) says how
many rows it hides, keeps its rollup, and says in bold when something inside
is waiting on you. Jumping to a queue entry inside a folded group (`Tab`, a
digit, a hint) unfolds what hides it. Which groups are folded belongs to the
window and survives a reload.

Where a finished line goes:

- A member that finishes stays in its group, dimmed, for 2 days, so a
  project's recent history stays with the project. After that it is counted
  in the head's rollup and no longer listed.
- A line directly under Main that is finished, with everything under it
  finished too, goes to Done as one line that says how many threads are
  under it.
- An archived line always leaves its place: archiving is you putting it
  away. It is listed under Done with its reason, as before.
- A line with a note of what is next, or with work listed as not started
  (see "What is next"), is not finished, and stays in the tree.

Parking a head takes its members to the shelf with it, counted on its line.

## Replies addressed to you

bb tracks unread replies only for threads without a parent, such as Main.
Under cow you also talk to threads that have one: a project thread that
Main started, say. So cow works out for itself whose a finished turn's
reply is. It is addressed to you when:

- the thread is a group head, whoever started the turn. bb's own notice
  that a thread under it finished starts a turn too, and that turn ends in
  a reply for you; or
- you started the turn with a message, from the page or anywhere else in
  bb. The first prompt a thread was started with does not count, though bb
  records it as sent by a person; nor does a message from another agent or
  one of bb's notices.

Such a line reads "replied to you: …" with the first line of the reply, is
in the state wants you, and is in the queue. A worker that finished a turn
its parent started is done, as before.

It stays until you have seen it. cow records the turn you last saw, per
thread, in the plugin's own storage, where an agent cannot write it. It is
set when you:

- open the thread's chat from the page (`Enter`), or have it open when the
  reply arrives;
- send it a message from the page (`I`, or `i` for a Main that has a
  parent);
- press `Space` on its line. `u` takes that one back.

A message you send the thread later, from anywhere in bb, also clears it:
you evidently read it. A reply that comes after the one you saw waits on
you again.

Main, when it has no parent, keeps bb's own unread record, as before:
opening its chat reads it. A Main that has a parent is treated like any
other group head.

cow reads the latest 40 turn starts and ends of a thread to decide this.

## What is next

The page shows what exists. A thread can also say what it intends:

- **A next note**: one line, in the thread's own words, of what happens
  next for it. It shows in the line's "next move" column in italics and
  quotation marks, in place of what cow works out. Where the next move is
  yours and has a key (a question, a permission, a refusal, a failure,
  parked work), cow's text stays.
- **Work not started**: a short ordered list. Each item is a row inside the
  thread's group, after its members, with a dashed mark and its place in
  the list. The cursor lands on these rows: `x` removes one (after `y`),
  `J` and `K` move it down and up, and `Enter` opens the chat of the thread
  it belongs to. Nothing else acts on them.

Both are written with `bb cow next` and `bb cow todo` (see the CLI), and
the page shows a change at once. A thread may write them only for itself
and for the threads under it. They are notes, not permissions: they change
nothing in bb, and a thread with either is kept in the tree as not finished.

The heading is an ordinary cursor stop: `k` from the first line reaches it,
`j` leaves it, and what makes sense on Main works there (`Enter` opens
Main's chat, `I` says to Main, `a` answers it, `x` stops its turn).

The line whose chat is open in the pane is marked "chat open", with a bar at
its far edge, apart from the cursor's bar at the near edge; the pane's
header names the thread. `i` always types into that chat, so the cursor can
be anywhere, and it is the only key that puts the caret there: `Enter` and
`m` open a chat and leave the keyboard with the overview, and `Enter` again
on the same line does nothing. `Enter` on another line is the deliberate way
to change which chat is open.

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

`u` takes back the last park, resume, archive (it unarchives), dismissal of
a refused permission, or mark as seen made with `Space`, then the one
before, for as long as the page stays open. Four things cannot be undone, and they say so: stopping a turn,
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
| ● | wants you | it asked you a question or for permission, or it finished with a reply addressed to you that you have not seen |
| ⊘ | blocked on a permission | bb refused it a command or a file change without asking you; `a` asks again as you |
| ▶ | running | a turn is in progress |
| ◆ | stuck | running with no event for 2 hours, or waiting on you for 7 days |
| ‖ | parked | you set it aside with `p`; it is on the shelf until it comes back |
| ✕ | failed | its last turn ended in an error; stays in the queue |
| ✓ | done | finished, or archived, in the last 2 days; older ones are only counted |
| ◌ | not started | not a thread: work a thread has listed for later |

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
bb cow next <thread> "<text>" | --clear
bb cow todo add <thread> "<title>"
bb cow todo done <thread> <n>
bb cow todo rm <thread> <n>
bb cow todo list <thread>
bb cow help
```

| Command | Does |
| --- | --- |
| `status` | the overview as text: the queue, then one line per thread with its state, time in state, and what it is doing or waiting on, then the parked shelf and what finished in the last 2 days |
| `archive` | archives a done or failed thread in bb and records the reason; refused while threads under it are still open |
| `park` | sets a thread aside; the reason is required, and `--pickup` is read exactly as the page reads a pick-up |
| `resume` | takes a parked thread off the shelf |
| `next` | sets, or with `--clear` removes, the one line that says what happens next for a thread |
| `todo add` | adds a piece of work not started to the end of a thread's list; the list holds 12 |
| `todo done`, `todo rm` | take item `n` off the list: its work has started, or it will not be done |
| `todo list` | the list, numbered from 1 |

`status` uses the Main last chosen on the page for the project the command
runs in, unless `--main` names one. Its output is bounded: at most 80 open
threads, 30 parked, 20 done and 20 queue entries are listed, and the rest are
counted. `park` refuses a thread whose turn is running unless `--stop` is
given, which stops the turn first, as the page does after asking. A refused
command exits non-zero and says why; every command takes `--json`.

`next` and `todo` may be run by a thread only on itself and on the threads
under it; bb tells the command which thread is calling, and any other
target is refused. `status` shows each thread's note and list, and for a
group what is under it by state.

The CLI has no undo: `bb cow resume` reverses a park, and
`bb thread unarchive` reverses an archive. Answering questions, granting
permissions and dealing with refused ones stay with you, on the page.

The plugin ships a skill, `skills/cow/SKILL.md`, that tells agents about
these commands.

## Develop

```sh
npm test            # unit tests: states, replies addressed to you, groups and folding, plans, refused permissions, parking, pick-up dates, verbs, answers, permission requests, the CLI, hints
npm run typecheck
```

`npm run e2e` drives the real page in a separate headless Chrome. It creates
seven cheap fixture threads titled "cow test", acts only on those (it answers,
stops and archives them for real, grants them permission to run `echo` and to
write one file under `/tmp`, and runs `bb cow` on them), and archives them
afterwards. See the top of `scripts/e2e.mjs` for how to run it.

## Turn it off

```sh
bb plugin disable cow   # unload it; your choice of Main is kept
bb plugin remove cow    # uninstall it and delete what it stored
```

cow stores four things: which thread was last chosen as Main for each
project; which reply of each thread you have seen; its notes on a thread
(why it is parked, why it was archived, which refused permissions you
dismissed, what the thread says is next and has not started), kept in that
thread's plugin metadata; and, in each window's session storage, the Main
that window shows and the groups folded in it.

## License

MIT
