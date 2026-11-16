# 🐄 cow

cow is a plugin for [bb](https://getbb.app). You run your work through one
long-lived **Main** thread that hands jobs to other threads, and cow gives you
one page that shows every one of them: what state it is in, for how long, what
it is doing, and what moves it next. The page is driven from the keyboard, in
the manner of vim.

## Status

Early. The page shows every thread's state and acts on it: you can answer a
question, park work and get it back, stop a turn, archive, and undo. A state
comes from what bb knows about a thread plus cow's own note when you have
parked it. Nothing tells cow yet that a thread is waiting on something other
than you.

A thread that finishes reports to the thread that started it, so it is that
thread's to deal with: its line turns done and still shows the first line of
what it reported. The queue holds only what is yours: questions, failures,
replies from Main that you have not read, and parked work that has come back.

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
| `M` | choose a different Main |
| `?` | the legend and this key map |

Acting: select a line first, then press the verb. The bar at the bottom shows
which verbs apply to the selected line and greys out the rest; a greyed-out
verb takes no hint, and its key says why it does not apply.

| Key | On | Does |
| --- | --- | --- |
| `a` | a line with a pending question | opens the question under the line: digits choose, `Enter` sends, `Esc` cancels |
| `p` | any line that is not parked | parks it: a reason, then a pick-up |
| `p` | parked work that came back | keeps it parked with a new pick-up; the reason stays |
| `r` | a parked line | resumes it: back into the tree |
| `x` | a line whose turn is running | stops the turn, after `y` |
| `x` | parked work that came back | drops it: stops and archives it, after `y` |
| `e` | a done or failed line | archives the thread in bb, after `y` |
| `u` | anywhere | undoes the last park, resume or archive, after showing what and `y` |

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

cow answers the agent's built-in questions. A permission request, or a form
that belongs to another plugin, is shown with what it is about and `Enter`
opens the thread's chat, where it can be answered.

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

## Undo

`u` takes back the last park, resume, or archive (it unarchives), then the
one before, for as long as the page stays open. Two things cannot be undone,
and their confirmations say so: stopping a turn, and answering a question.
Undoing a park that stopped a turn, or a drop, restores the line but the turn
stays stopped. bb archives the threads under a thread along with it; undo
brings those back too.

## States

| Mark | State | Means |
| --- | --- | --- |
| ● | wants you | it asked you something, or Main finished with a reply you have not read |
| ▶ | running | a turn is in progress |
| ◆ | stuck | running with no event for 2 hours, or waiting on you for 7 days |
| ‖ | parked | you set it aside with `p`; it is on the shelf until it comes back |
| ✕ | failed | its last turn ended in an error; stays in the queue |
| ✓ | done | finished, or archived, in the last 2 days; older ones are only counted |

The limits live in one place, `LIMITS` in `src/state.ts`.

## Develop

```sh
npm test            # unit tests: states, parking, pick-up dates, verbs, answers, hints
npm run typecheck
```

`npm run e2e` drives the real page in a separate headless Chrome. It creates
five cheap fixture threads titled "cow test", acts only on those (it answers,
stops and archives them for real), and archives them afterwards. See the top of `scripts/e2e.mjs` for how to run it.

## Turn it off

```sh
bb plugin disable cow   # unload it; your choice of Main is kept
bb plugin remove cow    # uninstall it and delete what it stored
```

cow stores two things: which thread is Main for each project, and a note on
each parked thread, kept in that thread's plugin metadata.

## License

MIT
