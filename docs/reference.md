# cow: reference

The [README](../README.md) says what cow is, how to install it and what it
stores and sends. This is the detail behind each idea: every rule the page
and the `bb cow` commands follow. Sections refer to each other by name.

Contents: [States](#states) · [Groups](#groups) · [Projects](#projects) · [Replies addressed to you](#replies-addressed-to-you) · [To settle](#to-settle) · [Keeping](#keeping) · [Automations](#automations) · [Outside Main](#outside-main) · [Other plugins on a line](#other-plugins-on-a-line) · [What is next](#what-is-next) · [Filtering](#filtering) · [Scrolling the chat](#scrolling-the-chat) · [The reader](#the-reader) · [Answering](#answering) · [Permission requests](#permission-requests) · [Blocked on a permission](#blocked-on-a-permission) · [Asks](#asks) · [Briefs and the checker](#briefs-and-the-checker) · [Parking](#parking) · [Waiting on someone else](#waiting-on-someone-else) · [Archiving, with a reason](#archiving-with-a-reason) · [The ledger](#the-ledger) · [Caps and stuck checks](#caps-and-stuck-checks) · [Undo](#undo) · [Capabilities](#capabilities) · [The CLI, for agents](#the-cli-for-agents) · [Theme](#theme)

## States

| Mark | State | Means |
| --- | --- | --- |
| ● | wants you | it has an ask open for you, it asked a question or for permission, one of its permission requests was decided outside cow, its brief has disputes or judgement calls you have not read, or it finished with a reply addressed to you that you have not seen |
| ⊘ | blocked on a permission | bb refused it a command or a file change without asking you; `a` asks again as you |
| ▶ | running | a turn is in progress |
| ◷ | waiting | its next move is someone else's, not yours: said with `bb cow wait` or `w`; see "Waiting on someone else" |
| ◆ | stuck | running with no event for 2 hours, or a question, a permission request or an ask waiting on you for 7 days. A reply never reads stuck: the thread is at rest, and reading it is yours to do when you choose |
| ‖ | parked | you set it aside with `p`; it is on the shelf until it comes back |
| ⌂ | kept | you keep it around with `z`; it is in the Kept section, asking for nothing, until it starts a turn; see "Keeping" |
| ✕ | failed | its last turn ended in an error; stays in the queue |
| ○ | idle | a project with nothing to say: quiet, in its place, never done; see "Projects" |
| ✓ | done | finished and not archived: it waits under To settle for your decision, however long ago it finished (see "To settle"); or archived, and listed under Archived for 2 days. A project is done only when archived |
| ◌ | not started | not a thread: work a thread has listed for later |

Two more marks sit beside a title, and say nothing about the thread's state:

| Mark | Means |
| --- | --- |
| ▤ and ✓, ▶ or ✕ | the thread submitted a brief, and a checker disputed none of its claims (✓), is auditing it now (▶), or failed to give a usable answer (✕: nothing in it is verified) |
| ▤ ≠ 2 | the brief has that many disputes: claims and task checks the checker disputes, and one when its diff changed what decides whether its checks pass |
| a key, and 3× | the thread holds a capability; capabilities have allowed that many of its requests. "new" beside it: one you have not acknowledged |

When several things wait on you at once, a line shows the first of: a
failure; a question or permission request raised in its chat, which holds a
running turn; an open ask; a request of its own that was decided outside cow;
a permission bb refused; a brief with disputes or judgement calls. With none
of those, it shows the first of: a running turn; waiting on someone else; a
reply addressed to you; idle or done. So waiting gives way to everything that
needs you, and a thread that has said it is waiting does not read "replied
to you" for the turn in which it said so. The others are still there when
that one is dealt with. This order lives in one place, `derive` in
`src/state.ts`.

A line does not read done for a moment between its turn ending and cow
reading how it ended: a thread bb says is at rest, whose newest turn event
read so far is a start, keeps reading as running until its end is read (or
for a minute at most).

The limits live in one place, `LIMITS` in `src/state.ts`.

## Groups

Any thread that has threads under it is a group: there is nothing to mark.
Its head is a project (see "Projects"), so a group stays on the page until
you archive it.
Its line is the head, in bold with a fold mark (▾), and its members are
listed under it along one continuous rule, so what belongs to what reads at
a glance. Groups nest, one rule per level.

The head's line carries a rollup of everything under it, at every level:
how many want you, are blocked, stuck, failed, running, parked, kept and done,
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
  project's recent history stays with the project. After that it goes to To
  settle, and is still counted in the head's rollup.
- A line directly under Main that is finished goes to To settle. A group's
  head is a project, so it is not finished until you archive it: then the
  group goes to Archived as one line that says how many threads are under it.
- An archived line always leaves its place: archiving is you putting it
  away. It is listed under Archived with its reason for 2 days, then leaves
  the page.
- A line with a note of what is next, or with work listed as not started
  (see "What is next"), is not finished, and stays in the tree.

Parking a head takes its members to the shelf with it, counted on its line.

## Projects

A **project** is a thread that lives for a long time and that you talk to. A
thread is a project when:

- it is Main; or
- it has, or has had, threads under it (a group's head); or
- it is marked as one: `P` on its line (and again to unmark; `u` takes
  either back), or `bb cow project <thread>` and `--clear` from the CLI.

That is how the page draws and sorts it. For outcomes, labels, the ledger
and the caps and stuck checks, a thread under a parent that is not marked
and whose own threads are all archived is a worker, not a project: a worker
that started and archived test threads of its own still gets its outcome
and its ledger row. Main and a marked project are never workers.

A project that is not archived is never done, and never moves to the To settle
section. When it has nothing to say (no turn running, nothing waiting on
you) it is **idle**: a state of its own, with
its own mark (○), that shows how long it has been quiet and, in the next
column, what it says is next. It stays in its place in the tree.

Everything else happens to a project as to any thread. A reply to a turn you
started waits on you in the queue; a reply to a turn you did not start (a
report from a thread under it, say) gives its line a small unread mark and
nothing more: see "Replies addressed to you". It can ask, be parked (it goes
to the shelf), run, and read as stuck or failed.
Archiving it with `e` is you saying it is finished: it leaves the tree and
is listed under Archived with its reason.

A project with nothing under it carries a small square (▫) before its name,
so it can be told from a worker at a glance; a group's head has its fold
mark instead. The mark is one of cow's notes on the thread.

## Replies addressed to you

cow works out for itself whose a finished turn's reply is, by one rule for
every thread under Main and for Main itself, project or not: **a reply
enters the queue only when it ends the thread's newest finished turn and you
started that turn**, with a message from the page or anywhere else in bb, or
said something into it while it ran.

A turn started by another agent's message, by one of bb's notices (a thread
under it finished, say) or by the prompt a thread was spawned with ends in a
reply that is not yours. bb records the first prompt as sent by a person
whoever sent it, so cow does not count it. cow tells prompts apart by bb's
record of each: who sent it (`initiator`, and `source` for the first prompt),
whether it started a turn or was said into a running one, and its
`systemMessageKind`: anything but "unlabeled", an ordinary message, is a
notice and never yours, whatever its `initiator` says.

The turn bb starts only to tell a thread that another was moved under it or
away from it ends in no reply at all: it is bookkeeping, and the reply
before it is the one that counts.

A reply that is yours reads "replied to you: …" with its first line, is in
the state wants you, and is in the queue. Once another turn has ended after
it, it no longer waits on you. A reply that is not yours, while you have not
seen it:

- on a worker, which is then done, puts it first under To settle, marked
  "unread";
- on a project or Main, which is then idle, puts a small dot after its name
  in a quiet shade of the theme's unread colour ("unread" to a screen reader
  and on hover). It is not in the queue, its state stays idle, and the dot
  never changes colour with age.

Everything else that waits on you still does, for a project as for any
thread: an open ask, bb's own question or permission request, a refused
permission, a failure, a brief with disputes or judgement calls, a wait
whose reminder has come, parked work that is back. An agent running a
project that needs you asks with `bb cow ask`.

However long a reply waits, it never reads stuck: the thread is at rest.

It stays until you have seen it. cow records the turn you last saw, per
thread, in the plugin's own storage and not on the thread. Setting that
record, and taking it back, is a signed call: see "Only you: signed calls".
It is set when you:

- open the thread's chat from the page (`Enter`, `m` for Main), or have it
  open when the reply arrives. A chat the page reopens by itself, on a
  reload or by bb's back and forward, marks nothing;
- send it a message from the page (`I`, or `i` for Main);
- press `Space` on its line. `u` takes that one back.

A line marked seen this way does not jump away. If its new state would move
it to another section (a worker that is now done goes to To settle), it stays
where it is, dimmed, with its new state and "seen, stays here until reload"
beside its name, and the cursor stays on it. It moves when the page is loaded
again, or when you park or archive it. This is the page's display alone:
what is stored, and `bb cow status`, show it where its state puts it. `u`
still takes the mark back.

A message you send the thread later, from anywhere in bb, also clears it:
you evidently read it. A reply that comes after the one you saw waits on
you again. On a page whose key is not enrolled none of these marks anything:
`Space` says "not marked as seen: this page's key … is not enrolled", and
opening the chat says the reply still waits on you, and why.

Main goes by the same rule and the same record, not by bb's own unread
record: reading Main's reply in bb's own chat, outside this page, does not
clear it here (a message you send Main does).

On a line to settle, and on an idle project's or Main's unread dot, the same
marks clear it: opening its chat, or `Space`; `u` brings it back. The line
is already in its place, so it does not stay anywhere else.

cow reads the latest 40 turn starts and ends of a thread to decide this.

## To settle

A finished thread that is not archived needs one decision from you, and
the To settle section, below Parked, lists every one. Nothing is hidden by
age, and none is in the queue for being old.

- **Order.** Lines with a reply you have not seen come first, marked
  "unread", then the rest; within each, the oldest first, by when the newest
  thing in it finished.
- **Age.** Each line shows how long ago it finished: plain at first, warm
  (the theme's amber) after 3 days, red after 7. The heading's count takes
  the colour of its oldest line, folded or not. The limits are
  `settleWarmMs` and `settleOldMs` in `LIMITS`, `src/state.ts`.
- **What archiving leaves behind.** A line says, from what cow already
  knows, what would be left behind by archiving it: a reply you have not
  seen, on it or on a thread under it; a next note or work not started; an
  open ask; a brief you have not read. cow does not look at git for this:
  whether its branch is merged is not shown, because bb does not give a
  plugin a thread's branch state.
- **Verbs.** `e` archives it with a reason (a worker is first asked what it
  came to: see "The ledger"), `p` parks it, `z` keeps it, `Enter` opens its
  chat and `i` types in it to carry on; `Space` marks it seen; `o` says what
  a worker came to without archiving it. The verb bar shows them.
- **Folding.** The heading is a cursor stop: `h` on it folds the section,
  `l` unfolds it, and `h` on a line in it goes to the heading. Folded, it
  still shows its count. The window remembers, as it does a group's fold.
- **A long list.** Every line is drawn. Lines off screen are not laid out
  until they come near (`content-visibility`), so a section of a hundred
  lines scrolls as smoothly as a short one.

Archived lines are listed apart, under **Archived**, with their reasons, for
2 days. Archived is the last section on the page.

**The order of the page.** Top to bottom: the tree, Parked, To settle, Kept,
Automations, Outside Main, then Archived. The cursor, `/`'s matches and
`bb cow status` (its text and its `--json`) go in the same order.

## Keeping

Some threads are not jobs: you are thinking something through, or keeping a
thought down, and may come back in months. Keeping is for those.

- **Keeping one.** `z` on any line that is not running, not Main and not
  archived asks for a few words, optional, and `Enter` keeps it. The words
  show on its line.
- **Where it goes.** The **Kept** section, below To settle, folded by
  default and showing only its count. Open, it lists what is kept, newest
  kept first, each with its words and how long it has been kept. Threads
  under a kept thread go with it, counted on its line, as with parking,
  except one with an open ask, which is listed after the Parked shelf for
  its ask (see "Asks").
- **What it asks for.** Nothing. It is never coloured, never in the queue,
  and nothing reminds you of it, however long it stays. Only what truly
  needs you shows through, exactly as on a parked line: its open ask, and
  that of a thread under it, which are in the queue and answered with `a`. Its failure, a refusal, or its
  reply wait with it.
- **Coming off the shelf.** By itself, when the thread starts a new turn:
  you typed to it, so you are being intentional about it again. It then
  reads as any other thread. `z` on a kept line takes it off at once. `u`
  takes back either.
- **Other verbs.** `e` archives a kept line and `p` parks it; a thread is on
  one shelf at a time, so keeping a parked thread takes it off Parked, and
  parking a kept one takes it off Kept.
- **Agents.** There is no command for keeping: it is yours, from the page,
  as marking a project from the page is. `bb cow status` lists kept threads
  under their own heading, so nothing is invisible to an agent. The note is
  one of cow's notes on the thread, in its plugin metadata, and archiving
  clears it. It is not signed: see "What is not signed, method by method".
- **The filter.** `/` finds kept lines even while the section is folded.

## Automations

Each run of a bb automation is a new thread with no parent, so the tree
never reaches it. This section shows bb's automations, each with its recent
runs.

- **Where it comes from.** cow's server asks bb's bundled automations
  plugin (`automations_overview`, then `automations_runs` for each enabled
  automation, the latest 20) and gives the page and `bb cow status` the
  same answer. Each call has a few seconds; a slow, failing, absent or
  disabled plugin means no section, with no error, and nothing else on the
  page waits for it. The page reads it when it opens, when a thread an
  automation started appears or changes, when the section is unfolded, and
  once a minute while it is unfolded: it cannot hear the plugin's own
  signals.
- **Where.** The **Automations** section, after Kept and before Outside
  Main. Folded by default with its count; `h` and `l` on its heading fold
  it and the window remembers. Its heading is never coloured.
- **A row.** One per automation, enabled ones first, then by name: its
  name; its bb project when that is not Main's; "a script" for a script
  automation; when it runs next in plain words ("in 25m", "in 3h", "today
  21:00", "tomorrow 09:00", "Mon 08:00", "paused", "ran once", "not
  scheduled"), in this browser's time zone (the server's, for
  `bb cow status`); and its last run's result with how long ago. For an
  agent run the plugin's "succeeded" only means its turn ended, so the
  result is what cow reads from the run's thread: done, failed, wants you,
  or running. A failed result says the first line of the error, and that
  result alone takes the failed colour.
- **Its runs.** Under the row, folded by default (`l` on the row unfolds
  them, `l` again steps onto the newest, `h` on a run goes back to the row;
  the window remembers): its open run threads, newest first, at most five,
  as ordinary cow lines with their state, time and what they last said,
  then how many older ones are not listed. A run's thread that is under
  Main (an automation that sends into an existing thread, say) stays in the
  tree, and the row says "runs in a thread under Main". A paused
  automation's runs are not read; its row shows what the plugin records of
  its last run.
- **The queue.** A run that needs you, because of bb's own question or
  permission request, an open ask, or a permission bb refused it without
  asking (blocked, ⊘), is in the queue like any thread, with the same keys:
  `a` grants a capability, asks again as you or dismisses it. A
  finished run is not, whatever it came to, is not under To settle, and is
  never coloured. The legend's counts are of the threads under Main only.
- **Verbs.** `Enter` on a run opens its chat; on an agent automation's row,
  its latest run's chat; on a script automation's row, what its last run
  printed, and its error and exit code, in the reader (a script run has no
  thread). `a`, `x`, `I` and `e` work on a run as on any line; `e` archives
  it and it leaves the section. A run is not parked, kept, marked as a
  project or waited on. There are no keys to pause, resume or run an
  automation, and cow never moves a run under Main.
- **Deleting one.** `e` on an automation's row deletes the automation, for
  one that was only ever a reminder, say. It asks first, naming it, saying
  whether it is enabled and when it would next run, that its past run
  threads are not deleted, and that it cannot be undone: `y` deletes, any
  other key cancels. The verb bar shows `e delete` on the row. Deleting is
  yours alone: it is a signed call (`automation_delete`), which cow's
  server carries out through the automations plugin's own
  `automations_delete`, and writes to cow's log under the key that signed
  it. There is no command and no unsigned method for it. `u` does not bring
  it back, and the message line says so. A run's threads stay where they
  are, and age out of the section as any archived line would once
  archived.
- **Filtering.** `/` finds automations by name and runs by title or what
  they said, while folded.
- **Agents.** `bb cow status` has an "Automations" heading with the same
  rows and runs, and `--json` an `automations` list: for each, `id`,
  `name`, `project`, `paused`, `mode`, `next`, `nextRunAt`, `last`,
  `lastKind`, `runs` (status lines), `older`, `moreRuns` and `intoTree`.
  The heading is left out when the plugin did not answer.

## Outside Main

The tree follows parent links down from Main, so an open thread with no
parent is on no page: old work, a thread you started by hand, a run another
tool started, or open work left behind when bb archived its parent (bb sets
the parent of a thread's open children to none when it archives it).

- **What is listed.** Every thread that is not archived, not hidden, has no
  parent, and is not Main or a thread above Main, in any bb project. A
  thread with threads under it is one line, with how many open threads are
  under it. Forks are listed, marked "a fork". Threads a plugin started
  (bb's `originPluginId`) are only counted, and so are the Mains chosen for
  other projects: "3 started by plugins, not listed". An automation's runs
  that the Automations section lists or counts are neither listed nor
  counted here, so nothing is counted twice.
- **Where.** The **Outside Main** section, after Automations and before
  Archived, which is last. Folded by default with its count showing; `h` and `l` on its
  heading fold it and the window remembers, as for To settle and Kept.
- **A line.** Its title; its bb project's name, when that is not Main's; how
  long since it last did anything (bb's `latestAttentionAt`); and whether it
  is running, wants an answer (bb's own pending question or permission
  request), or is at rest. All of it comes from bb's thread list: no thread's
  events are read for this section. It is plain: never coloured, never in
  the queue, and not counted in the legend's states.
- **Verbs.** `Enter` opens its chat in the pane, which says "not under this
  Main"; `I` says something to it; `e` archives it (see "Archiving one").
  `/` finds its lines even while the section is folded. The other verbs
  need the thread under Main first, and say so.
- **Archiving one.** `e` asks for a reason, as on any line, and `Enter`
  archives it in bb, with the threads under it. It is refused, with the
  reason, while its turn is running ("its turn is still running"), while bb
  is asking it a question or a permission ("bb is asking it a question"),
  while it has an open ask, or while threads under it are still open. A
  reason given before is not offered again here, as it is on a line under
  Main: cow reads no notes of an open thread outside Main. Archived, the
  thread is under no Main, so cow marks its note "outside" (kept even when
  no reason is given), and every Main's page lists it under Archived with
  its reason for two days, as `bb cow status` does. `u` unarchives it and it
  is back in Outside Main. Another project's Main, which this section only
  counts, is never archived from it.
- **Bringing one under Main.** `A` on its line, then `y`. The confirmation
  says what happens: bb makes the thread a child of Main and tells Main
  with a short notice ("… is now a child of this thread"), so **Main starts
  a turn**; and cow sets the thread's notifications to its parent to
  "stuck", so it tells Main only when it is stuck, not each time it finishes
  a turn (bb's default for a thread that had no parent is "auto", which
  would). The thread then reads as any other: in the tree, or under To
  settle if it is finished, and the cursor follows it. While it had no
  parent bb kept its own record of whether you read its reply; when bb had
  it as read, cow marks its newest reply seen as it moves it, so it does not
  come back as new. That mark is signed: on a page that is not enrolled the
  move still happens, and its reply may show as unseen until you open it.
- **Taking it back.** `u` puts back exactly what was there, recorded before
  the move: no parent, its sidebar section in bb, and its notification
  setting, and the seen mark if the move set one. bb gives a thread whose
  parent is cleared its old parent's section, so cow sets the section
  again after.
- **Refusals.** bb refuses a move that would make the tree more than 4
  levels deep (a thread with threads under it adds their depth), one under
  an archived or deleted Main, and one that would make a loop. The page
  says which, in plain words, and nothing changes.
- **Agents.** There is no command for moving: an agent uses bb's own
  `bb thread update <thread> --parent-thread <main>`. Nothing owns a thread
  outside Main, so only the thread that is Main (the one recorded for its
  own project) archives one with `bb cow archive <thread> --reason <text>`,
  under the rules above; the person may too, at a terminal. Any other thread
  is refused: "it is outside Main, and a thread archives only itself and
  what is under it: outside Main, Main archives it". `bb cow park` refuses a
  thread outside Main ("it is outside Main") and says to bring it under Main
  first. `bb cow status` lists
  the section under its own heading, "Outside Main", and `--json` has it as
  `outside`, with `outsideNotListed` counting what is left out. Moving is
  not signed: see "What is not signed, method by method".

## Other plugins on a line

bb lets any plugin add a short badge to a thread's row, and actions to a
thread's menu. cow shows both on its page. It does not know what they mean or
what they do: the plugin that registered them draws and runs them.

**Badges.** At the end of each line in the tree, Parked, To settle, Kept and
an automation's runs, after what is next, cow draws every badge other
plugins registered for that thread: a pull request's state, say. bb's own
GitHub pull-request status plugin registers one. None show on Main's
heading or on Outside Main lines.

- The line stays one line. Badges take what room is left after cow's own
  columns and are cut off with an ellipsis; they never wrap and never push a
  column. When the page is too narrow for the next-move column, the badges
  are hidden with it. With no plugin registering a badge, a line is
  exactly as it was.
- A badge never changes a line's state, its section or its place in the
  queue: cow reads nothing from it.
- A badge that fails takes out only itself: bb removes that badge on that
  line, and the rest of the line, and the page, carry on.
- A badge takes no hint and no keyboard focus, and a click on it selects its
  line. A link inside a badge takes a hint like any other link.
- Badges are drawn for the threads bb's own thread list holds: open ones.
  An archived thread's line has none.
- bb loads each plugin's data for its badges once for the whole page, not
  once per line. A plugin may make its own request for all the threads at
  once, as the pull-request one does.

**Actions.** `.` on a line opens, under it, the actions other plugins offer
for its thread, in bb's menu order. Each row has its label, its detail, the
plugin that offers it, and a digit or letter that runs it; `f` puts hints
on the rows. bb's own actions (pin, rename, archive and the rest) are left
out: cow has its own keys for what it does. bb's bundled plugins offer some
too: in bb 0.49, Notifications, and Move to section on a thread with no
parent.

- Picking a row calls the action as bb hands it over, bound to that plugin:
  it runs in that plugin's own code, under its authority. cow signs nothing,
  sends nothing for it, and records nothing.
- A dimmed row is one its plugin has turned off: it cannot be picked, and
  its key says so in the message line.
- An action with choices shows them as a second step: a key picks one, and
  Esc goes back to the list. Esc on the list closes it.
- The message line says when the plugin has finished. bb keeps an action's
  own errors to itself, so "ran" means the plugin finished, not that it got
  what it wanted: look at what it changed.
- With nothing to offer, `.` says so in the message line and opens nothing,
  and the verb bar shows `. more` only on a line that has something.
- Main's heading has actions too; an Outside Main line, an automation's row
  and an item not yet started have none.

## The context card

bb's own thread view has a context card: what bb and other plugins know
about the thread. bb gives a plugin's page no way to draw that card, so cow
draws its own, from two sources: bb's bundled plugins, and any plugin that
offers the method below.

**Where it shows.** On the overview, the selected line's card is at the
bottom of the right column, just above the legend, and follows the cursor:
every thread line has one (the tree, Main's heading, Parked, To settle,
Kept, an automation's runs, Outside Main), and section headings, an
automation's own row and items not yet started have none. With a chat open,
the card for that chat's thread is at the top of the pane, between its
heading and the conversation; there it is folded to its section titles when
it would take more than four lines, and a click or a hint on a title
unfolds that section. On a page narrower than 900 pixels the overview's card
is hidden with the legend; the pane's still shows.

- A thread with nothing to show has no card at all: no box, no heading.
- Each row is one line, cut with an ellipsis; it never wraps. The row a
  plugin marks as this thread's own stands out quietly, and badges take the
  theme's colours for passing, waiting, failing, information and quiet. The
  card has a bounded height and scrolls inside itself.
- It is not a stop for `j` and `k`. `f` hints its links, its changed files
  and, in the pane, its folded titles. A link opens as any link outside bb
  does; a changed file opens in the reader.
- `v` hides the card in this window, and shows it again; the window
  remembers across a reload. Other windows keep their own choice.
- The card is read once the cursor has rested on a line for about 150
  milliseconds, and each thread's is kept on the page for 30 seconds. While
  a new one loads, the card kept for that thread shows, or nothing: never
  another thread's.
- `bb cow status` does not show it.

**bb's own.** Read through cow's server, from bb's bundled plugins, with a
time limit of a few seconds each; one that is absent, slow or failing leaves
its section out.

- *Pull request*, from the GitHub pull-request plugin (`pullRequests`, for
  the thread's environment): number, title, the branch and its base, and
  badges for its state, its checks and its review, linking to it.
- *Changed files*, from the git plugin (`status`, for the thread's
  environment): what is committed on the branch and not merged, and what is
  not committed, each path once. The count is in the title; the first five
  are named and open in the reader.

A thread with no environment, or whose environment is not a git checkout,
has neither.

**Other plugins: `cow_card`.** Any plugin can add sections to cow's card by
registering one RPC method, `cow_card`, as discoverable. cow finds it
through bb's discovery of plugin methods; nothing is configured. This
contract is cow's own, not bb's, and may change before cow 1.0.

- Input: `{ threadId: string }`, one thread at a time.
- Output: `{ sections: Section[] }`; an empty list means nothing for this
  thread.

```ts
type Section = { title: string; rows: Row[] };
type Row = {
  text: string;
  url?: string; // http or https only
  detail?: string;
  badges?: { text: string; tone: "ok" | "warn" | "bad" | "info" | "muted" }[];
  current?: boolean; // this thread's own row in a list of several
  indent?: 0 | 1 | 2;
};
```

cow's server makes the call, so the other plugin sees cow as the caller,
with a time limit of two seconds. The answer is not trusted:

- What is not in this shape is dropped: a section without a title or rows,
  a row without text, a badge with another tone. A section left with no
  rows is dropped. Fields not listed above are ignored.
- At most 4 sections per plugin, 20 rows per section and 4 badges per row;
  the rest are left out. A title is cut to 60 characters, a row's text and
  detail to 160, a badge to 24. Line breaks and control characters become
  spaces.
- Everything is drawn as plain text; nothing is read as markup. A `url`
  that is not http or https, or longer than 2,000 characters, is dropped.
- A plugin that fails, answers late or answers nonsense leaves out only its
  own sections.

Sections are shown under the plugin's name: bb's own first, then other
plugins by name. Which plugins offer the method is looked up again every
15 seconds or so.

A plugin's server, in full:

```ts
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const contract = defineRpcContract({
  cow_card: { input: z.object({ threadId: z.string() }), output: z.object({ sections: z.array(z.unknown()) }) },
});

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(contract, {
    cow_card: async ({ threadId }) => ({ sections: [{ title: "Stack", rows: [{ text: `#12 for ${threadId}`, current: true, badges: [{ text: "ci ok", tone: "ok" }] }] }] }),
  }, { experimental_discoverable: true });
}
```

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
on the same line does nothing (on a chat the page reopened by itself, it
marks its reply seen). `Enter` on another line is the deliberate way
to change which chat is open.

The page's address names the open chat, so bb's own back and forward
(`Cmd+[` and `Cmd+]`) walk the chats opened on this page: each open, switch
and close of the pane is a step, and `Esc` back to the chat a link was
followed from takes the place of the step instead of adding one. When back
or forward brings a chat, the cursor goes to its line, and `Esc` closes it
rather than going back through links. A reload reopens the chat the address
names. A chat reopened by back, forward or a reload marks no reply seen:
only you opening it does. An address that names no thread this page knows
(deleted, mistyped, a link from another machine) opens nothing: the status
line says so and the address is put back to the page with no chat. An
archived thread's chat opens as `Enter` on its line would.

When a verb makes a line leave its place (park, resume, archive, drop), the
cursor goes to the next line down that stays, or up when nothing is below.
Undo puts the cursor on the line it brought back. Nothing else moves it.

While the cursor is in the overview, no key reaches the embedded chat, so a
stray digit cannot answer a question there. Keys with Cmd, Ctrl or Alt are
left to bb. "🐄 cow: choose the Main thread" is also in bb's command palette
while the page is open.

"🐄 cow: open cow's page" is in the palette everywhere, and bound by default
to Ctrl+Option+C (Ctrl+Alt+C off macOS); bb's keyboard settings rebind it.
From a thread's chat, another plugin's page or bb's own screens it opens
cow's page in place, without reloading the window, so bb's back returns to
where you were. With cow's page already in view it does nothing: the open
chat and the selection stay as they were. If another plugin asks for the
same default shortcut, bb leaves both unbound until you bind one.

## Filtering

`/` opens a small input in the status line. As you type, the page narrows
to the lines that match, in the manner of a fuzzy finder. A line matches
when every word you typed is found in it: loosely in its name (the word's
letters in order, with anything between them, so `sso cut` finds "SSO
cutover"), or exactly in what the line says it is doing. Case never matters.
Parked, to settle, kept and archived lines, lines outside Main and
not-started items are searched too, a folded section's included.

Matches stay in the page's order instead of being ranked, because ranking
would pull a line away from its group. The head of a group that holds a
match stays on the page, dimmed, so the match keeps its context, and a
match inside a folded group is shown. While the input is open every letter
is text, `j` and `k` included: `Ctrl+n`, `Ctrl+p` and the arrows move among
the matches. `Enter` closes the filter with the cursor on the chosen line
and the whole list back, unfolding what would hide that line, and the line
itself when it has threads under it, so `j` goes on to its first one; every
other fold is left as it was. `Esc` cancels: the cursor and the folds are as
they were.

## Scrolling the chat

With a chat open in the pane and the cursor in the overview, `;` and `'`
scroll the chat down and up a few lines, `:` and `"` half a page, and `\`
goes to its newest message. They are `j` and `k` moved one key to the right.
A held key keeps scrolling. The cursor does not move and the chat does not
take the keyboard. With no chat open they do nothing, and in any field they
are ordinary characters.

bb keeps a chat pinned to its newest message, and pins it again each time
text arrives. Two things follow, both bb's own behaviour and the same in its
thread view:

- a scroll bb does not take to be yours is put back. cow tells the chat a
  wheel moved before it scrolls it, and its first step away from the newest
  message is big enough to leave the pin;
- while text arrives, scrolling up in small steps (a trackpad's) never gets
  away from the newest message. In cow's pane, when you scroll up and the
  chat has not moved, cow moves it that far in one step, and it stays.

Scrolled away, the pane's heading says "new output below" when more has
arrived; `\` goes to it.

cow finds what to scroll without naming anything of bb's: of everything in
the pane that scrolls up and down, the tallest.

## The reader

A file opens over the whole page, read-only, in a reader that is cow's own:
never in bb's side panel. It opens from a click or a hint on:

| On the page | Opens |
| --- | --- |
| a link to a file in a chat, with or without lines (`src/keys.ts:62`, `README.md#L40-L44`) | that file, at those lines, with the lines marked |
| a file row in a chat's timeline ("Created sample.txt +3") | that change, as a diff |
| an evidence file in a brief, a proof file on an ask | the file in the thread's storage, as it is now |
| a link inside a file the reader is showing | the file it names, over the first |

cow hears the click before bb does, so bb's panel never opens. A click with
Cmd, Ctrl, Alt or Shift held is left to bb: on a file row it unfolds the diff
in the chat, as it did.

A link to a thread in the chat opens that thread in cow's pane, not in bb's
own chat page. bb draws two kinds, and cow knows both: a mention of a thread
in a message (`@thread:thr_…`, drawn as a pill with the thread's name), and
its own link to a thread above the composer, the parent's name. A plain
click, or a hint with `f`, switches the pane to that thread exactly as
`Enter` on its line would, opening a chat marks its reply seen and signs
that as it always does, and the cursor moves to its line when it is on the
page, unfolding the groups around it. A thread that is not under this Main
opens all the same, with "not under this Main" in the pane's header. A
thread bb has not told the page about, and a click with Cmd, Ctrl, Alt or
Shift, are left to bb. `Esc` then goes back to the chat you followed the
link from, one link at a time, before it closes the pane; `Enter`, `m` and
closing the pane start the way back afresh. bb shows no row of its own for a
thread an agent starts by running `bb thread spawn`, only the command, so
there is nothing there to follow. If bb opens a file tab on cow's page some other way,
cow closes it in the same moment and shows the file in the reader.

The heading gives the file's path under its root, which root that is
(workspace, thread storage, or the thread's machine), the thread it belongs
to and its size; for a diff, the kind of change, the two sides and the lines
added and removed. bb's own components draw the content, so code is
highlighted with line numbers, Markdown is rendered, and a diff is a diff, in
bb's theme. An image is shown. Anything else that is text is shown as text.

| Key in the reader | Does |
| --- | --- |
| `j` `k`, arrows | down, up a line; a number first repeats it (`5j`) |
| `Ctrl+d` `Ctrl+u` | half a page down, up |
| `Ctrl+f` `Ctrl+b`, `Space` | a page down, up |
| `g g`, `G` | the first, the last line |
| `12G`, `12 g g` | line 12 |
| `}` `{` | the blank line that ends the block below, above |
| `/` | search forward: every match is marked as you type; `Enter` goes to the first at or after the cursor, `Esc` cancels. Case is ignored unless the search has a capital |
| `n` `N` | the next, the previous match, round the end |
| `f` | hints on the links in the file |
| `r` | a Markdown file: rendered, or raw |
| `u` | a diff: unified, or split |
| `y` `Y` | copy the path; copy it with the cursor's line (`src/keys.ts:62`). The path is under the workspace for a workspace file, and absolute otherwise |
| `o` | open the same file in bb's own panel instead; `q` on the page then closes that tab |
| `q`, `Esc` | back: to the file this one was opened from, then to the page, which is as it was |

While it is open every key is the reader's: none of the page's verbs fire.
In the search field every letter is text. A link to lines of a Markdown file
opens it raw, so the lines can be marked; `r` renders it. In rendered
Markdown and in a diff the cursor moves over what is drawn (blocks, rows),
and `}` `{` move half a page.

An open file is read again every few seconds. When it has changed on disk
the reader shows it as it is now, keeps its place, and marks the heading
"changed".

What it does not show: a file that is not text or an image says so, with its
size, and offers `o` and `y`. A file of more than 6,000 lines is shown as
plain text without highlighting, and only the first 3 MB of a longer one is
shown. A diff comes from a chat's timeline; the reader does not diff a file
against git. There is no editing.

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
| Allow once, and save as a capability | cow's own choice, after bb's: opens the steps that make a capability from this request, and allows the request once when it is saved; see "Capabilities" |

Granting is deliberate. A digit only marks a decision and `Enter` confirms
it, so no single key grants anything. "Allow for the rest of this session"
needs a second `Enter`, after cow has named exactly what it grants (the
directories it may read and write, the network, commands like this one);
`Esc` there goes back to the choices. Denying with a message needs the
message.

No decision can be undone. Once allowed, the command runs or the file is
written at once, and a session grant lasts until the thread's session ends.
The card says so.

The page sends your decision to bb through cow's backend, as a call signed
with the page's key, and cow writes it in the log with that key. That is how
cow can tell a decision made on its page from one made somewhere else. A page
whose key is not enrolled cannot decide: see "Only you: signed calls".

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
| Save a capability for this | opens the steps that make a capability covering what was refused; nothing is sent. Once it is covered, the card opens with "Ask again as me" marked; see "Capabilities" |

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
- you dismiss it, or the thread is archived. Dismissing, and taking a
  dismissal back, are signed calls.

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

## Asks

A question an agent writes in prose scrolls away. An **ask** is one question
from a thread to you that stays open until you answer it or the thread
withdraws it. Agents raise one with the CLI:

```sh
bb cow ask --question <text> [--option <label>[::<detail>]]... [--options-only]
           [--risk low|medium|high] [--proof <path>]... [--context <text>] [--thread <id>]
bb cow asks [--thread <id>] [--all] [--json]
bb cow ask withdraw <id>
bb cow ask close <id> --answered <the answer you were given>
```

- A thread asks for itself, or for a thread under it; asking for an unrelated
  thread is refused. Several asks can be open on one thread, and each is
  answered separately. `ask` prints the ask's id.
- Up to 9 options. You can answer in your own words as well, unless the ask
  was made with `--options-only`. `--proof` names files in the thread's
  storage for you to look at.
- A thread with an open ask reads "asks you: …" with its oldest question,
  and "(and 2 more)" when it has several; a request for a capability reads
  "asks for a capability to …: press a to allow or refuse" instead (see
  "From an agent's request"). It is in the queue, on the page and
  in `bb cow status`, whatever else it is doing: still running, finished, or
  parked. Only an archived thread's asks are left out.
- **Under a parked or kept thread.** A thread under a parked or kept thread
  is set aside with it and not listed, except for an open ask: such a
  thread is listed after the Parked shelf for its ask alone, and is in the
  queue like any ask, its line and its entry saying "under parked “…”" (or
  "under kept “…”"), as `bb cow status` does. `a` answers it as any ask;
  answering it resumes nothing, and the thread above it stays where it is.
  Before 0.2.8 such an ask was in `bb cow asks` only, and counted by
  `bb cow status` as an ask on a thread it does not list.
- **Withdrawing and closing are shown to you.** When an agent (a command
  run in a thread) withdraws an ask, or closes one as answered in chat
  while you have not sent that thread a message since it asked, cow puts a
  trace in front of you: see "What an agent took out of your queue". A
  close after you did write to the thread is the ordinary case and leaves
  none. What you do, on the page or from a terminal, leaves none.
- **Only you answer**, on the page. There is no `bb cow answer`: a command
  cannot tell your terminal from an agent's, because an agent can clear the
  variable that names its thread. The page's answer is a signed call, so
  nothing else can answer through cow either: see "Only you: signed calls".
- The answer reaches the asking thread as a message from you that quotes the
  question and gives the answer, and starts its next turn if it had gone
  idle.

Asks are kept in the plugin's own storage, not on the thread, so the thread
that asked cannot edit the record of what you answered. They survive a
plugin reload and a restart of bb. An answer is recorded before it is sent:
if sending fails, cow sends it again the next time it loads.

### An ask answered in chat

You may answer an ask in an ordinary message to the thread instead of on
the page. The ask is not closed by that: cow never closes one by itself.
It can be closed from either side, and nothing is sent to the thread either
way:

- **The asking thread** closes it with `bb cow ask close <id> --answered
  "<your answer, quoted or closely paraphrased>"`. A thread above it may do
  the same; any other thread is refused. Withdrawing is for a question that
  no longer needs an answer.
- **You** close it on the page. When you have sent the thread a message
  since it asked (from anywhere in bb), its line and its queue entry say
  "you have messaged this thread since it asked", and the card offers one
  more choice, "already answered in chat", with the digit after the others.
  The digit marks it and `Enter` closes it. A message cow sent for you, as
  the answer to another ask of the same thread, is not counted.

A closed ask is a record of its own: not an answer given on the page and not
a withdrawal. `bb cow asks --all` shows each ask that has ended with who
ended it: "answered on cow's page", "closed by the thread: answered in
chat: …" with the answer as the thread gave it, "closed by the user on cow's
page: answered in chat", or withdrawn.

### Answering an ask

`a` on the line opens the ask under it: the question, its context, how much
is at stake, the options numbered with what each means, a field for an
answer in your own words (unless the ask takes only its options), and its
proof files as links that open in the reader. `f` puts a hint on each
link.

A digit marks an option; the same digit again unmarks it. With an option
marked, what you type in the field goes with it as a note. `Enter` confirms,
and how much it takes depends on the risk the agent gave:

| Risk | `Enter` |
| --- | --- |
| none, or low | sends the answer |
| medium | shows the answer back to you, and the thread it goes to; a second `Enter` sends it, `Esc` returns to the choices |
| high | shows it the same way and asks for the word `send`; `Enter` then sends it |

Nothing is sent on one key. An answer cannot be undone, and the card says
so. When it is sent the card says what was sent and to which thread.

A thread with several asks shows the oldest. The card lists the others and
answers them one at a time, oldest first, moving to the next after each;
`Tab` skips to the next without answering. An ask the thread withdraws
leaves the line, the queue and an open card at once.

cow does not use bb's own question forms for this. A form takes over the
thread's composer until it is answered, expires after seven days at most, and
is cancelled whenever the plugin reloads; an ask has to outlast all three.
The cost is that bb itself does not show the thread as waiting: only cow
does.

## Briefs and the checker

A report in prose is hard to judge, and an agent's own "I checked this" is
not a check. A **brief** is a finished job's report as a list of claims, each
with the evidence for it, and cow has a separate agent audit it.

```sh
bb cow brief submit <file.json> [--thread <id>] [--wait]
bb cow brief show <thread> [--version <n>] [--wait] [--json]
bb cow brief check <thread> [--model <id>] [--provider <id>] [--runs <n>] [--wait]
```

The file:

```json
{
  "summary": "One paragraph: what was asked and what was done.",
  "claims": [
    {
      "id": "limit",
      "text": "Login is limited to 5 attempts a minute per IP.",
      "label": "checked",
      "evidence": [
        { "description": "the rule as deployed", "text": "rate: 5/min key: ip path: /login" },
        { "description": "probe output", "path": "probe.txt" }
      ]
    }
  ],
  "judgementCalls": [{ "text": "Is 5 a minute too strict for the office NAT?", "askId": "ask_1a2b3c4d" }],
  "notDone": ["Not tried against production traffic."]
}
```

| Field | Rules |
| --- | --- |
| `summary` | one paragraph, up to 1200 characters |
| `claims` | 1 to 30; `text` up to 400 characters; `id` optional (`c1`, `c2`, … when left out) |
| `label` | the agent's own word: `checked`, `inferred` or `not-checked`. A `checked` claim needs evidence |
| `evidence` | up to 6 per claim, each a one-line `description` of up to 600 characters and exactly one of `text` (an excerpt) or `path` (a text file in the thread's storage). 12,000 characters each as the checker reads it, 60,000 in all |
| `judgementCalls` | up to 10 decisions that are yours; `askId` links one to an ask of the same thread |
| `notDone` | up to 20 lines: what was left undone or not checked |

Validation is strict, and an error names the field and what it must be.
Evidence files are read and copied when the brief is submitted, so the
checker reads what was submitted whatever happens to the files later.
Submitting again stores a new version; earlier ones are kept.

**The checker** is a separate agent in a thread of its own. Its whole input
is one message (see [What the checker is shown](#what-the-checker-is-shown)):
the task, what the thread changed, and the brief's claims with their
evidence. It is **not** shown the agent's summary or the agent's label for
any claim: telling a reviewer that work is fine makes it find less. It has no
parent, so it shares no conversation with the thread that did the work and
wakes nobody; it is hidden from the thread list, and its thread is stopped
and archived when it answers. For each claim it states in one sentence what
the evidence and the diff literally show, then gives a verdict: `supported`,
`not-supported`, or `cannot-tell` with what would settle it. It answers the
same way for each check of the task's "Done means" section, and may list
changed files that no claim accounts for.

- It is told to use no tool, and bb gives a plugin no way to start a thread
  without tools. So cow reads the checker's own timeline afterwards, and an
  answer from a checker that used any tool is thrown away.
- Its answer must be one JSON object with a verdict for every claim and for
  every check the task sets. Anything else (prose, a missing claim or task
  check, a `cannot-tell` that does not say what would settle it, an error, no
  answer in ten minutes) is a **failed check**, shown as one. It is never a
  pass.
- An answer that cannot be read (broken JSON, a claim or a task check left out) is tried once
  more with a fresh checker before the check fails: a slip in the form is not
  a verdict on the brief. A checker that used a tool, errored or said nothing
  is not tried again.
- **Where it runs.** In order: `--provider` and `--model` given to `bb cow
  brief check`, then cow's settings (below), then the provider and model the
  thread that submitted the brief ran on. bb's default provider is used only
  when none of these says anything: it may be one that is installed but
  cannot run here. A provider given without a model runs on that provider's
  default model, never on a model meant for another provider. The check
  records the provider and model it was started on and where each came from
  (`chosen` in `--json`: `given`, `setting`, `inherited` or `default`), and
  the sheet and `bb cow brief show` name them, adding "as the submitting
  thread ran" when both were inherited.
- **Its permission mode** is `accept-edits`, the narrowest of bb's three
  (`accept-edits`, `auto`, `full`): edits in its workspace go ahead, and
  anything else is put to you for approval rather than run. bb has no mode
  that refuses outright, which is why a checker that used a tool is thrown
  away, not trusted to have been stopped.
- **Where its thread starts.** The checker reads only its prompt, so it needs
  no checkout. Its thread starts in a personal workspace: an empty folder of
  its own in bb's personal project, which bb removes with the thread. bb makes
  it on its primary machine, and refuses when that machine is not connected
  or there is none; then cow asks for a personal workspace on the machine the
  submitting thread is on. It never starts in the submitting thread's
  worktree or in any other environment that holds someone's work: in
  `accept-edits` an edit there would be made before its answer could be
  thrown away. A brief from a thread that is archived, and whose worktree bb
  has removed, is checked like any other. With nowhere to start, the check
  fails, like any failed check, with "the checker could not be started: bb
  would not make it a personal workspace (on bb's primary machine: …; on the
  thread's machine: …). A checker runs only in an empty workspace of its own,
  never in the thread's checkout. When a machine of yours is connected, check
  it again: bb cow brief check <thread>".
- **When the checker cannot run.** A checker bb would not start, or whose
  turn failed, is a failed check whose reason says the provider and model it
  was started on, the cause in plain words where bb recorded one (such as
  "the provider is not signed in" or "the provider does not have that
  model"), and what bb said. When another provider or model could get past
  it (not signed in, no such provider or model, billing, a usage limit or
  budget, an overloaded provider, a brief too long for the model) it ends
  with the way out: `To check it on another provider: bb cow brief check
  <thread> --provider <provider> --model <model>`. Other failures (a
  connection that dropped, the sandbox, an environment bb could not give)
  do not suggest it. cow never retries on another provider by itself.
- A failed check keeps the reason and what the checker answered, as it came.
  The sheet and `bb cow brief show` print both, so that you can see whether
  it was the checker or the brief that went wrong. None of it counts as a
  verdict.
- The thread a brief is from cannot order its own audit. The thread above it
  can, and so can you. That rule goes by the name the caller gives, which is
  the caller's own word, so cow does not rest on it: see the next point.
- **A check run again that fails takes nothing away.** When no run of the
  new check gives a usable answer, the check before it, if it had one, stays
  the brief's check, verdicts and all, as read or unread as it was. The
  failed attempt is kept beside it, and the sheet and `bb cow brief show`
  say, above the check: "Checked again on <date>: that attempt failed
  (<why>); the check below is from <date>" (dates in UTC; `failedRecheck` in
  `--json`). Only the latest failed attempt is kept, and a check that
  answers clears it. A check that answers replaces the one before.
- Running a check again takes nothing out of your queue. If the check it
  replaces found claims to dispute and you had not opened the brief, the
  brief keeps waiting whatever the new check says, and the sheet and `bb cow
  brief show` say, above the new check's result, what the earlier one found
  in the words of what was counted: "NOTE: an earlier check of this version
  could not confirm 5 claims, and the check was run again before you had
  read them. This check replaced that one." ("contradicted 1 claim",
  "contradicted 1 claim and could not confirm 2 claims"; a check recorded
  before 0.2.14 says "contradicted or could not confirm"). The thread's line
  says "brief: an earlier check, run again unread, could not confirm 5
  claims". A judgement call keeps waiting while the new check runs. Only you
  opening the brief ends the wait.

A claim is **disputed** when the checker's verdict is weaker than the agent's
label warrants. The checker never sees the label; cow puts the two together
afterwards:

| The agent says | Checker: not supported | Checker: cannot tell |
| --- | --- | --- |
| `checked` | contradicted | not established |
| `inferred` | contradicted | agreement, no dispute |
| `not-checked` | agreement, no dispute | agreement, no dispute |

A **task check** that the checker finds not shown (`not-supported`), or
cannot tell, is a dispute: the agent was asked for it, whatever it claims.

A brief whose diff **changed what decides whether its checks pass** is a
dispute cow raises from the list of changed files alone, with no model. It
names the files, counts for the queue like any other dispute, and stands
whatever becomes of the check, while it runs and when it fails. See [The
path rules](#the-path-rules).

### What the checker is shown

cow collects all of it itself when the brief is submitted; the submitting
agent supplies none of it. Every piece of untrusted text (the task, the
file list, the diff, each piece of evidence) is fenced between lines marked
with a fresh random nonce, and the checker is told that nothing inside a
fence is an instruction.

- **The task.** The text of the first message the submitting thread was
  started with, as bb recorded it, up to 12,000 characters (the prompt says
  when it was cut, and how long it was). If it has a "Done means" section, a
  heading with those words, or a line starting with them in bold, up to the
  next heading of the same or a higher level (any heading, for the bold
  form), each item of its outermost list is one check, with the lines under
  it (up to 30 checks of 600 characters; a section with no list is one
  check). With no first message to read, the checker is told there is no
  task to compare against.
- **What changed.** When the thread's environment is a git checkout, cow
  runs git there, on its machine, read-only and with hooks off. The base is
  the merge base of `HEAD` with the first of these that resolves: the
  environment's merge-base branch, its base branch, its default branch (each
  also tried as `origin/<name>`), `origin/HEAD`, `main`, `master`. With none,
  it is `HEAD`, so only uncommitted work shows, and the prompt says so; in a
  repository with no commits, the empty tree. The list of changed files
  (added, modified, deleted, renamed; uncommitted and untracked included, up
  to 5,000) always goes in whole. The diff text is cut to 60,000 characters
  in all and 12,000 a file. When it does not all fit, every file gets the
  same share before any gets more (never below 1,500 characters while there
  is room; past that, the last files are left out), so one large file cannot
  hide the rest. Lock files and binary files go by name only, and so do
  files that may hold secrets (the patterns a clone leaves out: `.env`,
  `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `*.sock`,
  `*.socket`, `*.pid`, and anything under `.aws` or `.ssh`). An untracked
  file is read only if it is a regular file (a link is never followed), up
  to 200,000 bytes. The prompt names every file cut short, left out, or
  shown by name only, and the checker is told that when what was left out
  could decide a verdict, it cannot tell.
- **No diff.** With no environment, an environment that is not a git
  checkout, git failing, or the `checkerDiff` setting off, the check still
  runs, and the checker is told there is no diff and why.
- **The claims**: each claim's id and text, its evidence, and the list of
  what was not done. Not the summary, not the labels, not the judgement
  calls.

The budgets: 12,000 characters of task and 60,000 of diff, beside up to
60,000 of evidence, keep a whole prompt near 35,000 tokens: within what a
small model reads well, and small enough that the same material can be sent
to several runs.

**What the record keeps.** The brief's record says what its checker was
shown: whether it had the task, how many checks were taken from it, the base
revision and how it was chosen, up to 300 changed files with their status
and how many there were, what was cut, left out or shown by name only, and
the flagged files. bb keeps each stored value to 256 KB, and a record
already holds up to 60,000 characters of evidence, so the text itself (the
task, the whole file list and the clipped diff) is kept beside the record,
in rows of 30,000 characters each, where it is read back for a run of the
check again: every run of one version is shown the same material, whatever
the thread changed since. A brief stored before 0.2.18 has none of this,
and reads and shows as it did; checking it again collects the task and the
diff as they are then, and records that.

### The path rules

From the list of changed files alone (paths, never contents), a brief is
disputed as having **changed what decides whether its checks pass** when it:

- modifies, deletes or renames a **test file that existed at the base**. A
  test file is one under a folder named `test`, `tests`, `__tests__`, `spec`,
  `specs`, `e2e`, `__snapshots__`, `testdata`, `test-data`, `fixtures`,
  `__fixtures__` or `__mocks__`, or named `*.test.*`, `*.spec.*`,
  `*_test.go` (and `.py`, `.rb`, `.ex`, `.exs`, `.dart`, `.c`, `.cc`,
  `.cpp`), `test_*.py`, `*_spec.rb`, `*Test`, `*Tests`, `*Spec` or `*IT` (in
  Java, Kotlin, Scala, C#, Swift or PHP), `*.snap` or `conftest.py`. A new
  test file is not flagged;
- adds, changes, deletes or renames **configuration of continuous
  integration** (anything under `.github/workflows/`, `.circleci/`,
  `.buildkite/`, `.husky/`, `.gitlab/ci/`; `.gitlab-ci.yml`, `.travis.yml`,
  `azure-pipelines.yml`, `bitbucket-pipelines.yml`, `.drone.yml`,
  `Jenkinsfile`, `.pre-commit-config.yaml`, `lefthook.yml`), **a linter**
  (`.eslintrc*`, `eslint.config.*`, `.eslintignore`, `.stylelintrc*`,
  `stylelint.config.*`, `biome.json`, `.oxlintrc.json`, `ruff.toml`,
  `.flake8`, `.pylintrc`, `.golangci.*`, `.rubocop.yml`, `clippy.toml`,
  `.markdownlint*`, `.shellcheckrc`, `.swiftlint.yml`), **a formatter**
  (`.prettierrc*`, `prettier.config.*`, `.prettierignore`, `.editorconfig`,
  `rustfmt.toml`, `.clang-format`, `dprint.json`, `.swift-format`), **a type
  checker** (`tsconfig*.json`, `jsconfig*.json`, `mypy.ini`,
  `pyrightconfig.json`, `.flowconfig`) or **a test runner** (`jest.config.*`,
  `vitest.config.*`, `playwright.config.*`, `cypress.config.*`,
  `karma.conf.*`, `.mocharc*`, `.c8rc`, `.nycrc*`, `pytest.ini`, `tox.ini`,
  `noxfile.py`, `phpunit.xml`), wherever it is in the tree.

Files that often hold such settings among much else (`package.json`,
`pyproject.toml`, `setup.cfg`, `Cargo.toml`) are not flagged: most changes
to them are not to a check. The rules are in `src/briefs/paths.ts`.

### Reading a brief on the page

A line whose thread has submitted a brief carries its mark (see "States").
A finished thread whose brief has disputes, or lists judgement calls, wants
you and is in the queue ("brief: 2 disputed, 1 judgement call") until you
have opened it. A brief the checker did not dispute, and that leaves you no
decision, puts nothing in the queue.

`b` opens the brief as a sheet over the whole page:

1. what the check was: how many runs, of which model, or that it failed and
   why, or that none has run;
2. the disputes: first a change to what decides whether its checks pass,
   with the files; then the disputed claims, contradicted ones first; then
   the task checks not shown or that cannot be told. Each claim shows the
   claim, the checker's verdict, what the evidence literally shows, and only
   then the agent's own label, as the agent's words. "Contradicted" is
   filled in red; "not established" is outlined, and says what would settle
   it;
3. the judgement calls. One that was raised as an ask and is still open is
   answered in place with `a`;
4. the other claims. One the checker supported says "found it supported" and
   nothing more; then the task's other checks;
5. changed files no claim accounts for, as the checker read it: a note, not
   a dispute;
6. what the agent lists as left undone, what the checker was shown (the
   task and how many checks, the base, how many files, what was cut), then
   the agent's summary.

| Key in the sheet | Does |
| --- | --- |
| `j` `k`, `g g`, `G` | move between claims and judgement calls |
| `l`, `Enter` | open the claim's evidence in place: excerpts as text, and a file as the text that was submitted, with a link that opens the file as it is now in the reader; `q` there returns to the brief |
| `h` | close it |
| `a` | answer the judgement call under the cursor, when it is open as an ask |
| `c` | run the check again, after `y`: it costs a model run for each run in the settings, and replaces the verdicts once it gives an answer; if it fails, they stay |
| `f` | hints on what is in the sheet |
| `q`, `Esc` | close; the cursor returns to the line |

The sheet updates by itself when a check finishes. Opening a brief is what
marks it read, and that mark is a signed call: on a page whose key is not
enrolled the sheet opens, says "this brief still waits on you", and why. A
new check, or a new version, makes it yours to read again. A new version
replaces the one that was waiting: if its own check finds nothing to
dispute and it lists no judgement call, nothing waits, and the earlier
version's disputes are read with `bb cow brief show <thread> --version <n>`.

**What a check is, and is not.** It is one model's reading of the evidence
the agent attached, of the task, and of the diff, done without the agent's
conversation. "Supported" means that reader found the material shows the
claim. It does not mean the claim was verified against the world: the
checker runs nothing, so "the tests pass" is judged from what the evidence
and the diff show, not by running them. It sees what the checkout changed,
so a change the agent left out of its claims can be seen, but only as far
as the clipping allows, and it sees nothing outside the thread's checkout. A
failed check, or none, means nothing in the brief has been looked at by
anyone but its author; the page says so and never shows it as clean.

`bb cow brief show` prints the disputes first (a change to what decides
whether its checks pass; then each disputed claim with the checker's
verdict, what the evidence literally shows, then what the agent says;
contradicted before not established; then the task checks not shown or that
cannot be told); then the judgement calls; then the other claims and task
checks; then changed files no claim accounts for, what was left undone, and
what the checker was shown. The agent's label is always printed as "the
agent says", after the verdict, never as verification. `--json` adds
`tasks`, `flagged`, `unaccounted` and `shown`. `bb cow status` adds to a thread's line what its
latest brief came to, such as "brief disputed: 1 contradicted".

Settings (Settings → Installed plugins → cow, or `bb plugin config cow`):

| Setting | Default | Means |
| --- | --- | --- |
| `checkerProvider` | empty | the provider the checker runs on. Empty: the provider the thread that submitted the brief ran on, which is known to work here; bb's default only when that is not known |
| `checkerModel` | empty | the checker's model. Empty: the submitting thread's model when the checker runs on that thread's provider, otherwise that provider's default. A model set without a provider runs on the submitting thread's provider |
| `checkerRuns` | 1 | independent checkers per brief, up to 5. The weakest verdict stands, and a claim the runs disagree on says so |
| `checkOnSubmit` | on | check a brief as soon as it is submitted |
| `checkerDiff` | on | show the checker what the submitting thread changed. The file list and the diff are sent to the checker's model; files that may hold secrets are named, never shown. Off: no git is run for a brief, and the checker is told there is no diff |

A small model is cheaper, and its "not supported" is worth having, but its
"supported" is weaker than a large model's; more than one run shows where it
wavers. The checker catches what the evidence and the diff contradict or
fail to establish, and a task check they do not show. It cannot catch what
was cut to fit, what happened outside the checkout, or what only running
the code would show.

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
parked thread go with it and are counted on its line, except one with an
open ask, which is listed after the shelf for its ask (see "Asks").

Parking takes what the line was waiting on you for out of the queue: a
reply, a failure, a refusal, a brief. Its own open ask stays in the queue,
and so does an ask of a thread under it. An agent can park a thread too
(`bb cow park`), and parking is not signed, so the shelf is where to look
for work an agent set aside: see "What is not signed, method by method".
When an agent parks a thread that was waiting on you, a notice says so in
your queue until you acknowledge it: see "What an agent took out of your
queue". An agent is told this is no reason not to park when parking is
right.

Parked work comes back by itself, as an entry in the queue:

- when its date arrives; or
- with no date, every four weeks: "still parked for N weeks: keep, resume,
  or drop?". cow cannot detect a condition written in words, so it shows the
  condition and asks every four weeks as well.

On work that came back, `r` resumes it, `p` keeps it parked with a new
pick-up, and `x` drops it. Resuming only removes the note: the line returns
to the tree in whatever state bb gives it, and the agent is told nothing.
`I` says something to it if you want it to carry on.

## Waiting on someone else

Much work waits on someone who is not you: a reviewer, CI, a person outside
the team. Such a line is not yours to act on, and should neither sit in your
queue nor read as idle or done.

- **Setting it.** An agent runs `bb cow wait <thread> --on "<who or what>"
  [--for "<what is needed>"] [--remind <date|+3d|+2w>]`, on its own thread
  or one under it, as with `bb cow next`; a command run with no thread
  named, as from your terminal, may set it on any. On the page, `w` on a
  line asks who or what, then for a reminder or nothing. The reminder is
  read as a park's pick-up is, except that a condition in words is refused:
  it has to be a day.
- **What it shows.** The line keeps its place in the tree, with the mark ◷,
  in state waiting, and says "waiting on the reviewer · 3d" (and what for,
  when that was said). Its next move says when it reminds you. It is not in
  the queue, and `bb cow status` lists it as waiting.
- **Where it ranks.** It gives way to everything that needs you (see
  "States"), and to a running turn, and it outranks a reply addressed to
  you, idle and done.
- **Clearing it.** It clears by itself when the thread starts a new turn,
  whoever starts it: something has happened. An agent that is still waiting
  after that turn sets it again. It also clears with `bb cow wait <thread>
  --clear`, with `w` on a waiting line (`y` confirms), and when the thread is
  parked or archived.
- **The reminder.** When its day comes, the line enters the queue as "still
  waiting on the reviewer after 3 days". `a` on it offers `1` keep waiting,
  with a new reminder or none, or `2` it is back with me, which clears it.
  Without a reminder it never enters the queue for this reason.

`u` takes back setting, keeping or clearing it from the page. The note is
kept with cow's other notes on the thread, in its plugin metadata, and is
not signed: see "What is not signed, method by method".

## Archiving, with a reason

`e` on a done, idle, waiting, kept or failed line asks why, on one line. `Enter` archives; on an
empty line it archives without a reason. `Esc` cancels. Dropping parked work
that came back (`x`) asks the same way before it stops and archives it.

On a finished worker, `e` first asks what it came to, one key: `1` done,
`2` partial, `3` redone, `4` dropped, each with its meaning on the status
line, or `Enter` to leave it unsaid; `Esc` cancels. Then the reason, as
above. A finished worker is a line that is done, waiting or kept, and not a
project, Main or an automation's run; a failed line, a project, an idle
line and a line in Outside Main are not asked (`o` under Archived still
sets one for a worker). The outcome is saved after the archive, as a
signed call: on a page that is not enrolled the thread is archived and the
status line says the outcome was not saved. See "The ledger".

The reason is cow's note on the thread. It shows on the thread's line under
Archived ("archived: …"), where an archived line is listed for two days,
and then leaves the page. An archived thread waits on you for nothing, an open ask
included. An agent can archive a thread too, with `bb cow archive` or with
bb's own `bb thread archive`; neither is signed. `bb cow archive` refuses
the Main recorded for the caller's project ("Main cannot be archived from
here"), another project's Main ("it is the Main chosen for another
project"), a thread a Main is under ("a Main is under it"), a running thread
("its turn is still running"), and one bb is asking a question or a
permission ("bb is asking it a question"). A thread outside Main is archived
by the person or by Main only (see "Outside Main"). If you undo the archive the note stays on the thread,
so archiving it again offers the same reason; clear the line to archive
without one.

## The ledger

When a worker is archived through cow, cow writes one row for it in its own
storage, so the row outlives the thread. That makes a ledger of what
finished work came to, for choosing models and seeing what keeps needing
help.

**Outcomes.** One of four, each with one line of meaning wherever it is
chosen:

| Outcome | Means |
| --- | --- |
| `done` | the work was used as it came back |
| `partial` | some of it was used, or it needed a second worker |
| `redone` | it was wrong, and you or another thread redid it |
| `dropped` | it was not used |

It is never required. It is given by you, on the page (`e` on a finished
worker, or `o` on a line under Archived or To settle, which sets or changes
it; any other key cancels), or by an agent: `bb cow archive <thread>
--outcome <one>`, or `bb cow outcome <thread> <one>`, which works on an
open thread and an archived one, under the same rule of who may as
`archive`. The skill tells an agent that archives a worker it dispatched to
give the outcome honestly, and that "done" means the work was used as it
came back. An outcome can be changed later, since "redone" is often only
known afterwards; each change keeps who made it and when, and the row shows
the latest.

**Who judged.** Each outcome records who judged it: you (a signed call from
the page, or a command run outside any thread) or a thread, by its id. An
outcome you set is never overwritten by a thread: a thread that tries is
refused, and told that you judged it. `archive --outcome` is then refused
as a whole, and nothing is archived. You can change anyone's. On the page
it is a signed call (`outcome_set`), written to cow's log under the key
that signed it.

**Labels.** A dispatching thread can give a worker a label of its own
choosing, the kind of job, such as `lookup`, `draft` or `code-change`, so
the ledger can show whether each kind of job is on the right model: one
model does several kinds of work, and grouped by model alone a bad run of
code changes and a good run of lookups average out. `bb cow label <thread>
[<label>] [--clear] [--json]` shows, sets or clears it; `bb cow archive` and
`bb cow outcome` take `--label <label>` too. A label is lower-cased and must
then be one short word: `^[a-z0-9][a-z0-9-]{0,23}$` (letters, digits and
hyphens, starting with a letter or digit, at most 24 characters); anything
else is refused with that rule, so the ledger still holds no free text.
Who may set one is exactly who may set an outcome: the rule of where the
thread stands that `archive` has (any thread for a thread under a parent;
outside Main only Main, the thread itself or you; never a Main, or a thread
above one), and a label you set is never overwritten or cleared by a thread.
Unlike an outcome, it can be set before the worker has finished a turn: at
dispatch. It can be set before or after the worker is archived; a row
already written is updated, as a later outcome updates it. The page does not
show it on the thread's line.

**A worker** is a thread that finished a turn and is not a Main or an
automation's run, and is not a project by this rule: it is marked as one;
or it has a thread under it that is not archived; or, with no parent, it
has or has had threads under it. A thread under a parent whose own threads
are all archived is a worker, though the page draws it as a group's head.
Anything else gets no row, and an outcome for it is refused. (On the page,
`e` and `o` on a line drawn as a group's head still treat it as a project;
give it its outcome with `bb cow outcome` or `bb cow archive --outcome`.)

**The row.** Written when the worker is archived through cow (`e`, `x` on
parked work that came back, `bb cow archive`), whether or not an outcome was
given, and updated when the outcome changes. It holds, and only holds:

- the thread's id, its bb project's id, and the id of the thread that
  dispatched it (its parent when it was archived);
- the model and the reasoning effort its first prompt asked for, as bb
  records them on that prompt (`execution.model` and
  `execution.reasoningLevel` of its first `client/turn/requested` event);
  null when bb recorded none;
- when its first turn started and when its first report ended (the end of
  its first turn that finished normally), and the time between;
- the steers before that report: messages sent into the thread after its
  first prompt and before the report ended, counted apart for you and for
  other threads (bb's own notices are not steers);
- how many turns it ran in all;
- the outcome, who judged it, when, and how many times it was changed after
  it was first given;
- when it was archived, and by whom: you or a thread's id;
- its label, or null when it has none (a row written before 0.2.17 reads as
  none);
- the tokens it used, as four counts: input apart from the cache, cache
  reads, cache writes, and output (see "Tokens and dollars"). Null when bb
  recorded none; a row written before 0.2.19 reads as unknown usage, shown
  as "usage unknown", never as zero. When usage arrives after the row was
  written (a turn that ended after it was archived), the row is brought up
  to date, as a later outcome updates it;
- its tool calls and its working minutes (the lengths of its turns, summed,
  to a tenth of a minute), from cow's progress record (see "Caps and stuck
  checks"). Null when not read; a row written before 0.2.21 reads as null.
  Nothing summarises them yet.

It holds no dollars: they are worked out when shown, so a corrected price
applies to rows already written.

**It holds no title, no prompt, no message text and no reason.** Threads
archived before 0.2.11, or with bb's own `bb thread archive`, have no row.
Undoing an archive leaves the row; archiving the thread again writes it
anew. The threads bb archives along with a worker get no row of their own.

**Reading it.** `bb cow ledger [--days 14] [--by model|dispatcher|label]
[--json]` lists the rows archived in the window and a summary, by model, by
dispatching thread and by label (`--by` shows one grouping; `--json` always
gives all three, as `summary.byModel`, `summary.byDispatcher` and
`summary.byLabel`). By label, the rows with no label are under "(no label)",
and each label's workers are grouped by model again beneath it. Each group says how many
workers, how many of each outcome and how many unsaid, the median time to
first report, the median steers before it, and how many you judged. A group
of fewer than 5 workers shows its counts and says it is too small to
compare, with no percentages. `L` on the page opens the same summary for
the last 14 days over the page, with this month under Main (see "Tokens
and dollars") and the latest 20 rows (the page adds each
thread's title as bb has it now; the row holds none). `b` steps through
every grouping, by model, by dispatching thread and by label; `j` `k` scroll
it, `q` or `Esc` closes it. `bb cow status` shows an archived worker's outcome at
the end of its line: `[outcome: done, judged by the person]`; the page
shows "came to: done" on a line under Archived or To settle.

### Tokens and dollars

**Where the tokens come from.** bb records, at the end of a turn, an event
`thread/tokenUsage/updated` with two sets of counts. On bb 0.50 with Claude
Code, `total` is the running sum of every model call of the provider's
process so far, across its turns (a sub-agent's calls were not in it when
checked in 0.2.23: see [Tokens during a turn](#tokens-during-a-turn-liveusage)),
and it carries on across a compaction (the compaction's own
summarizing call is not in it); `last` is the latest turn's. bb does not
keep every such event: older ones are dropped after a few turns, and a
compaction drops all but the latest. A new provider process starts its
`total` from zero again under the same session id, and bb writes
`thread/identity` when one starts; on a long-lived thread that is often,
every few turns. So cow takes a thread's usage from its
latest `total` per provider session, the step from the one read before;
after a `thread/identity`, or when a `total` falls back, the new `total`
counts in full. It reads the usage of every thread as each of its turns
ends, so that what each turn added is put on the day it was used.

**Why a long-lived thread can show less than it used.** Two causes.
First, what bb dropped before cow read it is gone: everything a thread used
before cow first read it (0.2.19 is the first version that reads usage), and
any turn whose event bb dropped before cow read it. That is past only, and
cannot be got back: `bb cow spend` says so. Second, until 0.2.20 cow took a
new process's `total` for the old one's carried on whenever it was higher in
all four counts, which on a thread whose context only grows is often the
case after a single turn, and counted only the difference. That one is
fixed from 0.2.20 on; months already counted stay as they were. No
transcript is read. A thread with no such event has unknown usage: it is
counted as such and said, never shown as zero. A provider that counts cached
input inside its input (OpenAI's convention) is recognised from its
`totalTokens`, and the cached part is taken out of input; one that does not
split cached input into reads and writes has it all as reads.

**List prices.** cow keeps a small table of the providers' published API
prices per million tokens (input, cache read, cache write, output), each
entry with the date it was taken and the page it came from
(`src/prices.ts`): for Claude Code's models, Anthropic's pricing page; for
Codex's, OpenAI's (Standard tier). Pi's `openai-codex/…` models are priced
as the same model. Models with no published price there (every model
through OpenRouter, among others) have no entry: they show tokens and no
dollars, never $0. Where a cache write costs more for a longer cache
lifetime, the lifetime bb reported (`promptCacheTtlMs`) picks the price;
with none, the shortest. Claude Haiku 5.5 is priced by prompt length and
OpenAI's models by context length: cow uses the price for short prompts, so
very long prompts are under-counted. **Every dollar figure is an estimate at
list price, not a bill**: someone on a subscription is not billed this, and
the page and the commands say so wherever they show dollars.

**Changing a price.** The setting `listPrices` (bb's settings for the
plugin, or `bb plugin config cow set listPrices '<json>'`) is JSON of model
id to its price in USD per million tokens:

```json
{
  "claude-opus-5-5": { "input": 4, "cacheRead": 0.2, "cacheWrite": 8, "output": 20 },
  "my-model": { "input": 1, "cacheRead": 0.1, "cacheWrite": 1.25, "output": 5 },
  "gpt-5.5": null
}
```

An entry replaces cow's own for that model (its cache-write price then
holds for every cache lifetime), adds one cow has not, or with `null` takes
cow's out, so that model shows tokens and no dollars. A setting that does
not read leaves cow's table as it is and says why under the ledger. Since
dollars are worked out when shown, a changed price changes the dollars of
rows already written.

**In the ledger.** Every grouping (by model, by dispatching thread, by
label, and by model within each label) gives each group its tokens, their
list-price dollars, and dollars per done: **the group's dollars, every
outcome together, divided by how many of its workers came to done**, so a
cheap model that is often redone shows what each usable result really cost.
A group with rows of unknown usage or of a model with no price says how
many. `--json` gives the numbers: each group's `tokens`, `dollars`,
`dollarsPerDone`, `unknownUsage` and `unpriced`, and each row's
`listPriceUsd`, with `listPrice: true` and `estimate: true`.

**This month, everything.** `bb cow spend [--month YYYY-MM] [--main
<thread>] [--json]`, and the part of the `L` sheet below its note, give the
month's tokens and list-price dollars for every thread under the chosen Main,
archived or not (one archived before the month began is left out), split
into workers, project threads (as the page tells them), Main itself, and
cow's checker runs (the hidden threads cow starts to audit a brief, marked
`checker: true`: every one cow ran in the month, whichever Main's brief it
checked), with the total, and how many threads had no usage recorded. Days
are local time. Usage cow read before it first watched a thread's turns end
(a thread older than 0.2.19, or a turn that ended while cow was not
running) is put on the day of the latest event bb kept.

**Kept cheap.** cow keeps, per thread, what it has read of its usage, in
its own storage (one small value per thread, the last 400 days of it, kept
under bb's 256 KB a value): the counts so far, by day and model, and the
last event read. A turn's end reads only the events after that one. The
month's read lists bb's threads once and asks bb about a thread's events
only when bb has changed the thread since cow last read it: opening the
sheet again asks about nothing that has not changed.

## Usage and a budget

**The usage line.** One quiet line, always just above the status line, and
the same from `bb cow usage [--json]`:

- every usage window bb reports for every signed-in provider on this
  machine (what `bb settings usage` shows, read through the SDK's
  `system.usageLimits`): its label, the percent used and when it resets. A
  provider that is not installed, not signed in, expired, in error, or
  reports no windows is left out, not shown as an error. The account bb
  signs in with is never read.
- this month's list-price dollars of **every thread on this bb**, under any
  Main or none, hidden ones and cow's checker runs included, read as
  `bb cow spend` reads one Main's. With a monthly budget set: the budget,
  and the month-end figure at the current pace. With none, the month alone.

For example: `Claude Code Weekly limit 47%, resets in 19h (Sun 22 Nov 13:00) ·
Claude Code Fable 54%, resets in 19h (Sun 22 Nov 13:00) · Nov so far $43.03
at list price`. A window at or past its percent is drawn in the colour of
what needs you.

**The pace** is the dollars so far divided by the fraction of the month
gone (local time, to the millisecond), from the 3rd day of the month on;
before that it is not worked out, and the line says "pace from the 3rd".

**Settings** (bb's settings for the plugin, or `bb plugin config cow set
<name> <value>`):

| Setting | Default | What it does |
| --- | --- | --- |
| `monthlyBudget` | empty: none | US dollars at list price for the month, every thread on this bb, such as `500`. **Not a hard stop.** |
| `usageWindowPercent` | 80 | tell you when a usage window reaches this percent |
| `usageNotify` | on | also send a notification, through bb's push-notifications plugin, with the notice's text |

**A notice, once.** cow's server checks every five minutes, and when a
setting changes, whether the page is open or not. It puts one notice in
your queue:

- when a window reaches `usageWindowPercent`: which window, its percent and
  when it resets. Once per window per reset period: another can come only
  once bb reports that window with a later reset time, after the old one
  has passed. A window bb gives no reset time for can come again once it was
  seen below its percent. A window whose reset time has passed (bb has not
  read it again) raises nothing.
- with a budget set, when the month's dollars reach 80% of it (dollars so
  far and the budget), and when the pace goes over it (the pace, the
  budget, the dollars so far and how much of the month is gone). Each once
  a month.

A click on the notice, or its hint (`f`), acknowledges it, as a signed call
(`limit_ack`) logged under your key, like cow's other notices; it does not
come back until the next period. A notice not acknowledged when the next
period's comes gives way to it. With `usageNotify` on, the same text goes
to bb's notification channels when it is raised; without the
push-notifications plugin, or with no channel on, only the queue has it.

**It only tells.** Nothing in this part of cow starts a thread, sends a
thread a message, or pauses or stops one, and no agent is shown a budget or
asked to watch one: the check is code on cow's server, and what it finds is
for you.

## Caps and stuck checks

A worker that loops keeps making calls, so it never reads as stuck by its
events alone, and nothing else says it has gone far past what its kind of
job takes. cow keeps a small record of each running worker's progress and
**shows** you when one is over a cap or caught by a stuck check. **It never
stops, pauses, interrupts or messages a thread**, and no agent is shown its
cap: what cow finds is for you.

**Who is checked.** Workers only: a thread under a parent, not a Main, not
marked as a project, with no open thread under it (the rule of "A worker"
under [The ledger](#the-ledger)), not an automation's run, not archived.
Main and project threads never get a mark or a notice.

**What cow keeps per worker**, in its own storage, brought up to date when bb
says the thread's events changed (cow's server is told, then reads the turn,
item and usage events after the last one it read): its tool calls so far
(items that are not reasoning, messages or plans; a command moved to the
background is not counted twice), when its first and its current turn
started, the lengths of its finished turns, when its last event was, what
is in progress and since when, when a file last changed, and the last 5
calls' identity: the kind of item, a hash of the whole of it (the command;
or the tool with its arguments; or the paths), and a label of at most 60
characters: a command's first line, or a tool's name alone. **It keeps no
message text, no output, no file contents and no tool arguments**, and no
command past those 60 characters.

**Caps**, from one setting, `caps`: JSON keyed by label (`bb cow label`),
with `*` for workers of any other label or none. Each entry has any of
`toolCalls` (a whole number), `minutes` (wall-clock since the worker's first
turn started) and `dollars` (list price, from the usage cow reads as each
turn ends: **so known only once a turn has ended**, unless `liveUsage` is on;
see [Tokens during a turn](#tokens-during-a-turn-liveusage)). Such
as:

    {"lookup": {"toolCalls": 40, "minutes": 20}, "code-change": {"dollars": 5}, "*": {"minutes": 90}}

A worker labelled `lookup` is held to its own entry, not to `*`'s. A cap is
gone over, not reached: a cap of 2 tool calls is over at 3. Caps apply
whether its turn runs or not. Empty, the default, means no caps. A value
not in this form (not JSON, a key that is no label, an unknown field, a
number that is not above zero, tool calls that are not whole) is reported on
the page above the queue, and **no cap applies at all**: never some of
them.

**Stuck checks**, on by default, only while the worker's turn is running,
each with its own setting; 0 turns it off:

| Setting | Default | Caught when |
| --- | --- | --- |
| `stuckRepeats` | 3 | the same call (the same command, or the same tool with the same arguments) this many times or more in a row |
| `stuckQuietMinutes` | 15 | its turn runs with no event and nothing in progress for this many minutes |
| `stuckLongItemMinutes` | 45 | one item (a command, a tool call) has been in progress this many minutes |

Turns are not counted for any of this: a long command moved to the
background ends a turn, and a new one starts when it finishes.

**The mark.** A worker over a cap or caught by a check has, on its line,
which and by how much, for as long as it is true: `over cap: 512 of 400 tool
calls`, `over cap: 95 of 60 minutes`, `over cap: $3.20 of $2.00 (list price,
known only once a turn has ended)` (with `liveUsage` on and the turn running
on Claude Code: `(list price, the running turn read from Claude Code's
transcript)`), `the same command 4 times` (or "the same
tool call"), `quiet 22m`, `one command in progress 52m`. `bb cow status`
shows the same marks in brackets at the end of the line, and `--json` gives
each as `watch: [{reason, mark, facts}]`, the facts being the numbers behind
it (tool calls, minutes since its first turn, its label, and the call or the
times).

**One notice per worker per reason.** The first time a worker is over a cap
or caught by a check, cow puts one notice in your queue with the facts it
collected and nothing else, such as: “Fix the parser” (lookup) is over cap:
41 of 40 tool calls. 41 tool calls, 12m since its first turn started. cow
does not stop it. A click, or its hint (`f`), acknowledges it as a signed
call (`watch_ack`) logged under your key; an unsigned call is refused. Once
raised, that reason does not come back for that worker, acknowledged or not;
the mark stays while it is true. With `watchNotify` on (the default), each
notice is also sent as a notification through bb's push-notifications
plugin, the same route as the usage notices: so at most one per worker per
reason. The notice is in your queue either way.

**When it is checked.** When a worker's events change, and once a minute on
cow's one timer, which the usage notices share, page open or not, and when a
setting changes. `bb cow status` checks every worker as it reads.

### Tokens during a turn (`liveUsage`)

bb reports a thread's tokens only when a turn ends, and a worker is often one
long turn, so without more a `dollars` cap can say nothing until the worker
has finished. With the setting `liveUsage` on (**off by default**), cow reads
the token counts Claude Code writes as the turn goes.

**What is read.** Only for a worker cow checks (see above) whose turn is
running, on Claude Code, and only while it runs. cow's host entry, on the
worker's machine, opens one file: `~/.claude/projects/<folder>/<session
id>.jsonl`, where `<folder>` is the worker's environment path with every
character but letters and digits made `-` (from the path as bb gives it, and
from its real path), and the session id is bb's `providerThreadId` for the
thread. It builds that path itself, refuses a session id that is not plain
(letters, digits, `-`, `_`), follows no link (neither the folder nor the
file may be one), opens nothing else, reads at most 4 MiB a call (four calls
a check; a long transcript is caught up over a few checks, and a single line
longer than a read is passed over), and leaves a half-written last line for
the next read. A missing file is no usage known, not an error. From each
line that holds usage it takes `message.id`, `message.model`, the four counts
(`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`,
`output_tokens`), `timestamp` and `isSidechain`; one message is written as
several lines with the same usage, so each `message.id` counts once.

**What is kept.** In the worker's progress record: the session id, where the
next read starts, this turn's four counts by model, and a hash of each of the
last 64 message ids with its counts (to count a message whose lines span two
reads once). **No text, no tool input, no file name or path from the
transcript is read out of the host entry or kept: only numbers**, model ids
and hashes. Nothing is read or kept for a thread that is not a running
worker, or with the setting off.

**What it gives.** Model calls stamped from the turn's start (or from bb's
latest usage event in it) on count; earlier ones are passed over. Their
list-price dollars, added to bb's figure for the turns that ended, are what
the `dollars` cap is held to while the turn runs, and the worker's line shows
`$0.42 so far` (or the tokens, with no price for its model). The mark says
the figure is read from Claude Code's transcript. **When the turn ends, bb's
own figure replaces the reading**: the reading is dropped when bb writes the
turn's usage or its end, and bb's figure is read before the events in each
check, so a turn can be missing for a moment and is never counted twice. The
usage cow keeps per thread (the ledger, the month's spend, the usage line)
comes from bb's figure only, as before.

**What was found, and what was not.** On bb 0.50 with Claude Code, the four
counts summed this way over a turn equal bb's end-of-turn `total` exactly. A
compaction appends to the same file under the same session id; its own
summarizing call writes no usage line, and bb does not count it either. A
sub-agent writes its lines (`isSidechain` true) to files of its own, beside
the session's file under `<session id>/subagents/`, which cow does not read,
and bb's `total` did not include them in that check: so neither figure counts
a sub-agent's tokens. Not found: what happens to the file and the session id
when the provider process starts again (cow starts the file again from the
beginning when the session id changes, and when the file is shorter than
where it had read to). A folder name over 200 characters, which Claude Code
shortens with a hash, is not found: no usage is known for it. Any other
provider: no reading, as before.

## Undo

`u` takes back the last park, resume, archive (it unarchives), dismissal of
a refused permission, mark as seen made with `Space`, project mark, wait
set, kept or cleared with `w` or `a`, keep made with `z`, or move under Main
made with `A`, then the one before, for as long as the page stays open. Taking back a dismissal or a
mark as seen is signed, like making it. Five things cannot be undone, and they say so: stopping a turn,
answering a question, answering an ask, deciding a permission request, and sending a message.
Deleting a capability has its own undo, `u` in the capabilities sheet.
Undoing a park that stopped a turn, or a drop, restores the line but the turn
stays stopped. bb archives the threads under a thread along with it; undo
brings those back too.

## Capabilities

A worker sometimes needs to write outside its workspace, or to run a command
outside bb's sandbox, and to do it more than once. A **capability** is a
named grant you give to threads for that. When bb raises a permission request
on a thread, and a capability that applies to that thread covers the whole
request, cow answers bb "allow once" for you and writes it in a log. Nothing
wider is ever answered: no session grant, and nothing that outlives the one
request.

A capability is one of two kinds:

| Kind | Covers |
| --- | --- |
| Write a directory | creating and changing files anywhere under one absolute directory |
| Run a command | one command bb asks about, given as the exact command line, or as a prefix of its words (`git push origin` covers `git push origin main`) |

It has a name, an optional note, who it applies to, when and how it was
made, and a count of what it has allowed. It applies to one of:

- one thread, and no other;
- a thread and every thread under it, now and later;
- every thread under a Main, now and later (not the Main itself).

On this bb, "bb asks about a command" means the agent asked to run it outside
the workspace sandbox. Credentials are not part of this: bb writes the
environment values a plugin contributes into the thread's event log
unmasked, so cow hands out none.

**Read the limits before you rely on it.** bb does not tell a plugin who is
calling it. cow therefore takes nothing only you may do unless it is signed
with a key your browser holds: see "Only you: signed calls". That stops a
sandboxed agent from making a capability, or acknowledging one, through cow.
It rests on your browser's key store and on bb's sandbox, and bb's own
commands remain open to every thread: "What cow cannot guarantee" says what
was tried and what each attempt came to.

### Making, viewing and deleting

Only you do these, on the page, and each is a signed call. There is no
`bb cow` command and no agent tool that makes, changes, grants, deletes or
acknowledges a capability.

**From a permission request.** The card (`a` on the line) has one more
choice after bb's own: "Allow once, and save as a capability". Its digit
marks it and `Enter` opens the steps under the line:

1. **The rule**, proposed from the request: the directory the file is in, or
   the exact command. Edit it: delete from the end of a directory to widen it
   to a parent; for a command, `Tab` switches between the exact line and a
   prefix, and you cut the line down to the words that must match.
2. **A name**: what the log and each line will call it. Names in force
   differ.
3. **A note**, or nothing.
4. **Who it applies to**: the thread, the thread and everything under it, or
   everything under Main. A digit marks one.
5. **One sentence** that says exactly what will be allowed for whom, such as
   "The thread “billing” and every thread under it, now and later, may create
   and change files anywhere under /srv/reports, each time bb asks, without
   asking you." `Enter` here is the confirmation: it saves the capability and
   answers the request it came from "allow once". `Esc` goes back a step at a
   time, and out of the first step with nothing saved and the request still
   waiting.

**From a permission bb refused.** The blocked card has a fourth choice,
"Save a capability for this", with the same steps. Nothing is sent to the
thread. Once saved, the refusal reads as covered: see "Using one".

**From the sheet.** `C` opens the capabilities sheet over the whole page:

| Key in the sheet | Does |
| --- | --- |
| `j` `k`, `g g`, `G` | move between the lines |
| `n` | make one from scratch, through the same steps, starting with its kind. "Who it applies to" is offered around the line the cursor was on when you pressed `C` |
| `x` | delete the one under the cursor, after a confirmation that names the threads that lose it; `y` confirms |
| `u` | put back the one deleted last from this sheet, after `y`. It counts as new again |
| `Enter` | its history, in place: when it was made, each request it allowed, when it was acknowledged, deleted or put back. On a page that asks to be enrolled: approve its key, after `y` |
| `x` on a key | refuse a page that asks, remove an enrolled key, or forget a refusal, after `y`; see "Only you: signed calls" |
| `Space` | acknowledge what is marked new on the line |
| `Tab` | the log, and back. The log shows the entries of this window's Main and the threads under it, and those about no thread (keys, a reset); `a` there shows all |
| `f` | hints on what is in the sheet |
| `q`, `Esc` | close |

Each capability is one line: its name, its kind, the rule, who it applies to,
how often it has been used and when last, and when and how it was made. A
capability that was deleted before you acknowledged it stays listed, struck
through, until you do.

**On a line.** A thread that holds any capability carries a small key mark
after its title, with the number of requests capabilities have allowed on it.
`c` on any line shows which capabilities apply to that thread and where each
comes from: its own, from a named thread above it, or from Main. `c` or `Esc`
closes it. The `C` entry in the bar at the bottom always says how many
capabilities are in force.

**From an agent's request.** An agent cannot make a capability, but it can
ask for one:

```sh
bb cow caps [--thread <id>] [--all] [--json]     # what a thread holds, and where each comes from
bb cow caps log [--limit <n>] [--json]           # the log, newest first: capabilities, and what agents took out of the queue
bb cow cap request --kind dir|command --rule <text> --why <text> [--thread <id>]
```

`cap request` raises an ask on the page. Its line and its queue entry say
what it asks for and how it is decided: "asks for a capability to write
under /srv/reports: press a to allow or refuse" (for a command: "asks for a
capability to run “npm test”: …"), and the next move reads "press a to allow
or refuse". With the line selected, the verb bar shows `a` first, as "allow
or refuse". `a` opens its card: "Capability request · for <thread>", the
request ("“<thread>” asks for a capability to write under /srv/reports"),
"Why, in its words: …", and both choices at once: `1` allow it, `2` refuse
it. `1` opens the steps at once, starting from what was asked for, which you
can narrow or widen, and nothing is granted until you confirm their last
sentence; the capability then lasts until you delete it, and the thread is
told what was granted. `2`, then `Enter`, tells it no, as a message from
you. A rule that could never be
granted is refused when the agent asks, with the reason, and no ask is
raised. `caps` and `caps log` only read.

### What is refused

A directory rule is refused, with the reason, when it is:

- relative, or starts with `~` (only a shell expands that), or has a `..` in
  it, or has a control character in it, or is longer than 1,024 characters;
- the root of the filesystem;
- a home directory, or a directory that contains one (shell start-up files
  live in the home directory itself). That is your home directory on the
  machine bb's server runs on, and, because a thread may run on another
  machine or as another account, any `/Users/<name>` or `/home/<name>`, and
  root's own;
- one of the protected places, inside one, or a directory that contains
  one. The protected places are bb's data directory (which holds cow's own
  storage and every thread's storage, worktrees bb manages included) and,
  under any of those home directories: `.bb`, `.claude`, `.codex`, `.ssh`,
  `.aws`, `.azure`, `.kube`, `.docker`, `.config`, `.gnupg`,
  `.password-store`, `.local/share/keyrings` and `Library/Keychains`. These
  comparisons ignore case and Unicode form, because the disk does. The list
  is in one place, `PROTECTED_IN_HOME` in `src/caps/paths.ts`;
- on the machine bb's server runs on: a directory that is a symbolic link to
  any of the above.

A command rule, exact or prefix, is refused unless it is **plain words**:

- words of letters, digits and `_ @ % + = : , . / -`, separated by spaces or
  tabs; text in single quotes; text in double quotes that has no `$`,
  backtick, backslash or `!` in it;
- so anything else outside single quotes is refused: `; & | < > ( ) { } [ ]
  * ? ~ ! # $ ^`, the backtick and the backslash, a line break or any other
  control character, an unclosed quote, a first word that is a variable
  assignment (`NAME=value`), and a word that starts with `=`.

A prefix rule must also have at least two words, and may not start with a
shell or a command whose job is to run another command (`sh`, `bash`, `zsh`,
`env`, `sudo`, `xargs`, `eval`, `exec`, `nohup`, `time` and the like: the
list is `RUNNERS` in `src/caps/command.ts`). That list catches the plain
mistake and nothing more. A prefix such as `python -c` or `node -e` is
accepted and covers whatever code follows it; the sentence in the last step
says "whatever follows them" for that reason.

### Using one: the exact rules

When bb raises a permission request, cow looks at the capabilities in force
that apply to the thread. A request is **covered** only when:

- **Directory rule, file change.** bb names at least one file; every path is
  absolute, has no `..` in it and no control character; and every path is
  inside the directory, compared segment by segment and exactly, so
  `/srv/reports-old/a` is not under `/srv/reports`, and neither is
  `/srv/Reports/a`. The directory itself is not inside itself. A directory
  rule never covers a command, whatever the command would write.
- **Symbolic links.** When the thread runs on the machine bb's server runs
  on, cow follows the links in the directory and in each path (through the
  deepest part that exists) and requires each file to really be inside where
  the directory really is, and outside every protected place. So a link
  inside the directory that leads out of it is not covered, while a
  directory under `/tmp` on macOS, which is itself a link, still works. On
  any other machine cow cannot look, the answer stands on the paths as
  written, and the log entry says "symbolic links could not be followed".
  Either way a link made after cow looked and before the write is not seen.
- **Exact command rule.** The request's command line equals the rule
  character for character. A second space is a different command.
- **Prefix rule.** The request's command line is plain words, as above, with
  no operator or expansion anywhere in it, and its first words are the
  rule's, word for word. Quoting does not matter (`git push 'origin' main`
  begins with `git push origin`); `git push originx` does not.
- **A command with a shell operator or expansion in it is never covered.**
  No rule can be made from one, and no prefix reaches past one.
- bb offers "allow once" for the request. cow never answers anything else.
- The capability is read again from storage at the moment of answering, and
  must still be in force and unchanged.

Anything cow cannot read with certainty is not covered: a kind of request
other than a command or a file change, a file change bb has not named the
files of, a path or a command outside the grammar above. An uncovered
request shows the ordinary permission card, as before. The rule does not
look at the directory a command runs in.

When a request is allowed this way it never reaches you. The thread's line
says "allowed by <name>" for ten minutes, while it has nothing to ask you,
and its key mark counts it.

**Deleting takes effect at once.** Nothing cow granted outlives the single
request it answered, so the next request needs you again.

**Refusals on turns you did not start.** bb refuses those without asking, so
there is no request for a capability to answer. When everything bb refused a
thread is covered by its capabilities, its line says "covered by <name>" and
its card opens with "Ask again as me" already marked: `a`, then `Enter`. The
request bb raises when the thread tries again is then allowed. cow never
sends that message by itself. Whether a refusal is covered is judged on the
paths as written; the links are followed when the request comes.

### The log, the notices, and approvals cow did not make

cow records and shows what happens, whoever did it:

- **The log.** Every capability made, deleted or put back, every notice
  acknowledged, every trace of what an agent took out of your queue (below), every request allowed through a capability (when, on which
  thread, what, by which capability), every decision made through cow's page,
  every message sent and ask answered as you, every reply marked as seen,
  refusal dismissed and brief marked as read (and each of those taken back),
  every Main recorded, every decision cow saw made somewhere else, every
  capability a thread asked for, and every key enrolled, asked for, refused
  or removed, and every reset. Marks made by opening a chat or a brief are
  entries like any other, so the log grows with use. A listing (the sheet
  reads 500, `bb cow caps log` prints 50) counts its length in the entries
  that are not such marks, and adds the marks made since the oldest of
  them, so marks never push a capability, a decision or a key out of what
  is read. Each entry for
  something only you may do names the key that signed it. The sheet shows it
  newest first (`Tab`), and no key, command or interface method edits or
  clears it. Entries are numbered and each carries
  the hash of the one before, so an entry removed from the middle, or
  changed, shows as "the log is broken at entry N". The chain holds no
  secret: see the limits.
- **A notice for every new capability.** Making one, or putting a deleted one
  back, raises "capability added: <name>: <rule> for <whom>" in the queue,
  for the ones you just made yourself too. It stays until you acknowledge it
  with `Space` in the sheet, which is logged. Until then the capability is
  marked new in the sheet, on `c`, and on the line of every thread that holds
  it. A notice outlives its capability: one made and deleted before you saw
  it still waits.
- **What an agent took out of your queue.** Three things an agent may do,
  and is right to do when they are right, take something out of your queue.
  Each is shown to you when a command run in a thread does it:
  - `bb cow park` on a thread that was waiting on you at that moment: it
    had an open ask, one of bb's own questions or permission requests, a
    refused permission not dismissed, a failure, a brief with disputes or
    judgement calls, or a reply addressed to you not yet seen. Parking a
    thread that waited on nothing leaves no trace;
  - `bb cow ask withdraw`;
  - `bb cow ask close --answered` when you have not sent that thread a
    message since the ask was raised (the same test as "you have messaged
    this thread since it asked", so a message cow sent for you as the answer
    to another ask is not counted).

  Each is a notice at the top of the queue, with the other notices: which
  thread did it (by its title), to what (the thread, and for an ask its
  question), what it claimed (the park's reason, or the answer it says you
  gave), and how long ago. It stays until you acknowledge it. `C` opens the
  sheet, where these are listed first under "Taken out of your queue by an
  agent"; on one, `Enter` opens that thread's chat and `Space` acknowledges
  it, a signed call that is logged; `u` does not bring it back. Clicking
  the notice in the queue, or its hint, opens the sheet on it. Each trace
  is also an entry in the log (the capability log, which despite its name
  holds these too), and `bb cow status` lists the ones not acknowledged
  under "Taken out of the user's queue by an agent". Parking from the page,
  and anything you do, leaves none; so does parking by calling cow's
  interface directly instead of `bb cow park`: see "What is not signed,
  method by method".
- **Approvals cow did not make.** cow knows the requests it answered: the ones
  you decided on its page, and the ones a capability allowed. When a
  permission request it was watching is decided any other way, the thread's
  line reads "approved outside cow: run: … · in bb's own view, or by another
  thread" (or "denied outside cow"), wants you, and is in the queue until you
  press `Space` on it. It is logged, and so is the acknowledgement. If you
  approve a request in bb's own chat, this is what you will see; cow cannot
  tell that from another thread running `bb thread interactions approve`,
  because bb records no one for either.

### Only you: signed calls

bb serves a plugin's interface to any local process, and does not say who is
calling. So cow does not take a caller's word for anything only you may do.
The page proves it is yours with a signature.

- **A key the page holds.** The first time a browser opens cow, the page makes
  a signing key pair (ECDSA P-256, with WebCrypto). The private half is made
  non-extractable and kept in that browser's own storage (IndexedDB) for bb's
  address; no script, cow's included, can read it out. The public half is
  what cow's backend knows. A key is shown as a short fingerprint, such as
  `445f-d491-2add-8ca0`.
- **What is signed.** Everything only you may do: making, deleting and
  putting back a capability; acknowledging a notice or a decision made
  outside cow; deciding a permission request; every message cow sends as you
  ("ask again as me", "carry on without it", the reason for a denial, `I` and
  `i`); answering an ask, or closing one as already answered in chat;
  marking a reply as seen and taking that back; dismissing what bb refused
  a thread and taking that back; marking a brief as read; recording which
  thread is a project's Main, which is where a new window starts; deleting
  one of bb's automations; saying what a worker came to, for the ledger;
  approving a workspace file's content (`workspace_approve`, which carries
  the hash of the content shown) or dismissing its notice
  (`workspace_dismiss`); bringing a thread's work back with the approved
  back commands (`workspace_back`); reading a workspace command's last
  output (`workspace_output`); for a clone held back from removal, running
  its approved teardown again (`workspace_held_teardown`), reading what its
  teardowns printed (`workspace_held_output`) and removing it for good after
  a y confirmation (`workspace_held_remove`); and approving, refusing or removing a key. Opening a chat or a brief on the
  page, which marks a reply seen or a brief read as a side effect, signs
  that mark the same way. The list is `PERSON_ACTIONS` in
  `src/signing/envelope.ts`. None of these is a method of cow's interface.
  There is one method, `signed`, and it acts only when the call carries
  a signature, by an enrolled key, over the action's name, all of its
  arguments, a time and a nonce. A call signed more than two minutes ago, or
  before cow last started, is refused; so is one that was already used.
- **What is not.** What agents are meant to do stays unsigned: `bb cow ask`,
  withdrawing or closing their own ask, `brief submit`, `brief check`,
  `next`, `todo`, `park`, `resume`, `archive`, `project`, `cap request`, and
  everything that only reads. So do the page's own ways of doing the same
  things. Each is in the table under "What is not signed, method by
  method", with what it can change for you. Typing into a chat's own
  composer is bb's, not cow's.
- **The log names the key.** Each log entry for one of those actions records
  the fingerprint of the key that signed it, and `C`, `Tab` shows it. cow
  writes such an entry only for a verified signature.

**Enrollment.** With no key enrolled, the first page to open cow enrols its
key, and says so in a notice at the top of the page with the fingerprint:
trust on first use. After that, another browser (the web page as well as the
desktop app, a second machine) is not enrolled by opening cow. Its page shows
its fingerprint and waits; every enrolled page shows "a page asks to act as
you: key …" in its queue. `C` there lists the keys: `Enter` on the request
approves it after `y`, `x` refuses it. Compare the fingerprint with the one
the waiting page shows before you approve: the name beside it is that page's
own word. The sheet lists each enrolled key with how and when it was
enrolled and when it was last used; `x` on one removes it, after `y`, and
`x` on a refusal forgets it so that page can ask again. Approving, refusing
and removing are signed like everything else.

**A page that is not enrolled** reads everything and can do none of the
above. A notice at the top says so, with its own key and how to get
enrolled, and each verb that needs a signature says the same instead of
acting ("not sent: this page's key … is not enrolled, so this page can only
read. Approve it from a page that is enrolled …"). `Space` on a reply says
"not marked as seen: …"; dismissing a refusal says "not dismissed: …" on its
card; an opened chat says "its reply still waits on you: …"; an opened brief
says "this brief still waits on you: …". Choosing a Main there changes that
window only. Such a page can still park, resume, archive, mark a project and
change a list of work not started: those are not signed for anyone.

**If something else enrolled first.** On a cow with no key, whatever opens it
first holds it, and an agent could be first. Then your own page is the one
that is not enrolled, and it says so in red: "cow's person-only actions are
held by a key that is not this page's". That notice is the evidence. To take
it back, from your own terminal:

```sh
mkdir -p ~/.bb/plugins/cow && touch ~/.bb/plugins/cow/reset-enrollment
```

(The page prints the exact path: it is `plugins/cow/reset-enrollment` under
bb's data directory.) cow removes the file, clears every enrolled key and
every request, writes the reset in the log, and the next page to open is
enrolled. The path is under bb's data directory and outside thread storage
because bb's command sandbox does not let a thread write there.

### What is not signed, method by method

Everything below is open to any local process, a sandboxed agent included,
by `bb cow`, by `bb plugin rpc call` or by HTTP. Two things hold for all of
it. Nothing here is written to the log, apart from `cap request` and the
traces of "What an agent took out of your queue" (`park`, `ask withdraw`,
`ask close`, run in a thread). And the
CLI's rules about whose thread a command may touch go by the thread the
caller names in `BB_THREAD_ID`, which bb sets for a thread and the thread
can change or clear: a caller that names nobody is taken for you at a
terminal and may touch any thread, so those rules guide a well-behaved
agent and stop no other.

**Methods of the interface** (what the page calls)

| Method | What it does | Meant for an agent? | What an agent calling it could hide from you or change |
| --- | --- | --- | --- |
| `main_state`, `notes_list`, `asks_list`, `brief_get`, `brief_marks`, `caps_state`, `caps_log`, `keys_state`, `automations_read`, `card_read`, `ledger_read`, `watch_read` | read: the recorded Mains, cow's notes on threads (parks, archive reasons, dismissals, what is next, work not started, replies seen, project marks, waits, keeps), asks, briefs, capabilities, the log, the keys, bb's automations, a thread's context card, the ledger, the caps and stuck-check marks and notices | yes: `bb cow status`, `asks`, `brief show`, `caps`, `ledger` read the same | nothing. They change nothing |
| `signed` | carries out one of your actions when the call is signed by an enrolled key | no | nothing without a signature: an unsigned or forged call is refused and changes nothing |
| `key_enrol` | presents a key. With none enrolled it is enrolled; otherwise it becomes a request | no, but any caller can | on a cow with no key enrolled, it becomes the enrolled key, and your page then says in red that it is not: see "If something else enrolled first". Otherwise it adds a request to your queue under a name of its choosing, at most 8 at a time, and can do nothing until you approve it |
| `park_set` | writes or removes a thread's park note, with none of the CLI's checks | the page's `p` and `r`; an agent uses `bb cow park` and `resume` | **parking takes a line out of your queue.** The thread leaves the tree with every thread under it. What it waited on you for (a reply, a failure, a refusal, a brief, a decision made outside cow) stops waiting, and so does everything that threads under it waited on you for, except their open asks. Still visible: the line is on the Parked shelf with the reason given, how long, and how many threads went with it; its own open ask, and those of threads under it, stay in the queue; and it returns to the queue on its pick-up date, or every four weeks without one. A caller can set that date far ahead, and can change the reason or the date of a park you made. This method leaves no trace in the queue or the log, unlike `bb cow park`. Removing a note only puts a line back |
| `keep_set` | writes or removes a thread's keep note, with none of the page's checks | the page's `z`; there is no command for it | **keeping takes a line out of your queue** as parking does, and with no date to bring it back. What it waited on you for (a reply, a failure, a refusal, a brief, a decision made outside cow) stops waiting, and so does what threads under it waited on you for, except their open asks. Still visible: the line is in the Kept section with the words given and how long it has been kept, `bb cow status` lists it under Kept, its own open ask stays in the queue, and it comes off the shelf when the thread starts a new turn. Keeping also takes a park note off. Removing a note only puts a line back |
| bb's own `threads.update` (no method of cow's) | moves a thread under another, or out from under it | the page's `A`, which moves a thread from Outside Main under Main; an agent uses `bb thread update --parent-thread` | **moving a thread out from under Main takes it, and everything under it, out of your queue**, and off the tree. Still visible: a thread left with no parent is listed under Outside Main, on the page and in `bb cow status`, and one moved under such a thread is counted on its line there. Moving one under Main only adds to the page; bb starts a turn of Main's to tell it. cow cannot sign this: it is bb's |
| `thread_archive` | archives a thread in bb with a reason, and stops its turn first when asked to; a worker gets its ledger row, archived by you | the page's `e` and `x`; an agent uses `bb cow archive`, or bb's own `bb thread archive` | **archiving takes a line out of your queue**, with whatever it waited on you for, an open ask included, and bb archives the threads under it too. Still visible: the line is listed under Archived with its reason for two days. cow could not stop this by signing it: `bb thread archive` is bb's and does the same. The ledger row it writes says you archived it; it sets no outcome |
| `archive_note_set` | sets or forgets the reason kept for an archived thread | the page, when an archive is undone or redone | the reason shown under Archived can be changed or removed. It archives nothing and moves nothing |
| `wait_set` | writes or removes a thread's note that it waits on someone other than you | the page's `w` and `a` on a reminder; an agent uses `bb cow wait` | **setting it takes a reply addressed to you out of your queue**: the line reads waiting instead of "replied to you", until the thread starts a new turn. Still visible: the line stays in the tree, says who or what it waits on and for how long, and gives way to everything else that needs you (an ask, a question or permission request, a refusal, a failure, a brief with disputes or judgement calls). A caller can also remove a reminder, or one you set |
| `project_set` | marks a thread as a project, or takes the mark off | the page's `P`; an agent uses `bb cow project` | taking the mark off a thread with no threads under it moves it, once finished, from idle in the tree to done under To settle. Whose its replies are does not change: that is decided by who started each turn, for a project as for any thread |
| `todo_change` | removes an item from a thread's list of work not started, or moves it | the page's `x`, `J` and `K`; an agent uses `bb cow todo` | a not-started row can be removed from the tree or reordered. Those rows are never in the queue |
| `brief_check` | starts a new check of a thread's latest brief, with the model, provider and number of runs the caller names | the page's `c` in a brief; an agent above the thread uses `bb cow brief check` | it costs a model run each time, and replaces the verdicts the brief shows with the new check's once it answers. A caller who makes it fail, say by naming a model that does not exist, replaces nothing: the earlier check stays, with the failed attempt beside it. **It cannot take the brief out of your queue**: a dispute you have not read keeps the brief waiting through the new check and whatever it says, and so does a judgement call. On a brief you had read it does the opposite and makes it wait again |

Recording which thread is Main (`main_choose`) was one of these until 0.2.1.
A window keeps the Main chosen in it, but a new window starts on the
recorded one, so a caller could have a new window open on another thread's
tree, with a queue that is not yours. It is signed now. Marking a reply as
seen, dismissing a refusal and marking a brief as read were three more.

**Commands of `bb cow`** (what an agent is meant to use)

| Command | What it does | What an agent running it could hide from you or change |
| --- | --- | --- |
| `status`, `asks`, `brief show`, `caps`, `caps log`, `todo list`, `help` | read | nothing |
| `ask` | raises an ask for the caller's thread or one under it | adds to your queue. It hides nothing |
| `ask withdraw <id>` | takes an open ask out of your queue, unanswered | **the ask leaves your queue.** Run in a thread, a notice in the queue says which thread withdrew it and its question until you acknowledge it, and the log keeps it; `bb cow asks --all` lists it as withdrawn. Meant for the thread that asked and the threads above it; a caller that names nobody can withdraw any ask, and leaves no trace |
| `ask close <id> --answered <text>` | closes an ask as answered in chat, recording the answer the caller says it was given | the same, with the caller's account of your answer kept on the ask. Run in a thread when you have not sent that thread a message since it asked, a notice says so, with the answer it claims, until you acknowledge it, and the log keeps it. Closing one from the page as you is the signed `ask_close` |
| `brief submit` | stores a new version of a thread's brief and has it checked | the new version replaces the one that waited. If its check disputes nothing and it lists no judgement call, nothing waits, and the disputes of the version before are no longer in front of you; every version is kept and `bb cow brief show <thread> --version <n>` prints it |
| `brief check` | as `brief_check` above; refused to the thread the brief is from when it names itself | as `brief_check`: it costs a run and cannot take a waiting brief out of your queue |
| `cap request` | raises an ask for a capability and writes "requested" in the log | adds to your queue and grants nothing |
| `wait`, `wait --clear` | as `wait_set` above, for the caller's thread or one under it | as `wait_set`: a reply addressed to you leaves the queue while the thread is said to be waiting, and the line says who on |
| `next`, `todo add`, `todo done`, `todo rm` | the thread's own line of what is next, and its list of work not started | the next-move column of a line that waits on nothing shows the agent's words, marked as its own. A line with a note or a list stays in the tree instead of going to To settle. Nothing leaves the queue |
| `project`, `project --clear` | as `project_set` above | as `project_set` |
| `park`, `resume` | as `park_set`, under the page's rules: not Main, not an archived thread, not one already parked unless it has come back; a running turn only with `--stop` | as `park_set`. An agent can park any thread it can name, itself included, and "keep parked" one that had come back to your queue, with a new date. Run in a thread on a thread that was waiting on you, a notice says which thread parked it, why and when until you acknowledge it, and the log keeps it |
| `archive` | as `thread_archive`, under the page's rules: only a done, idle or failed line, one blocked with its turn over, or one waiting only for its brief to be read; never one with an open ask or with open threads under it, never a Main, and a thread outside Main only when the caller is Main. With `--outcome`, also as `outcome` below | a failure, a refusal or an unread brief leaves your queue with the line. Still visible under Archived, with its reason, for two days |
| `outcome` | says what a worker came to, open or archived, under `archive`'s rule of who may | nothing leaves the queue. Run in a thread, the ledger records that thread as the judge, and an outcome you set is refused. A caller that names no thread is taken for you, as everywhere here: its outcome is recorded as yours, and only the signed `outcome_set` is certainly yours |
| `ledger` | reads the ledger | nothing |
| `spend` | reads the month's tokens and list-price dollars | nothing |
| `usage` | reads the usage line: windows, the month, the budget and pace, the usage notices waiting | nothing. Only the signed `limit_ack` acknowledges a usage notice |
| `status`'s caps and stuck-check marks | read: a worker's marks, beside its line and in `--json` | nothing. Only the signed `watch_ack` acknowledges a worker notice, and nothing stops a worker |

What follows from this: **the queue is everything cow knows waits on you,
minus what has been parked, kept or archived.** Nothing else of cow's that is
unsigned takes an entry out of it, apart from a thread withdrawing or
closing an ask, replacing its brief with a new version, taking a project
mark off, or saying it waits on someone else, which hides only a reply. What bb's own commands can do to it is under "What cow cannot
guarantee". So the Parked shelf, Kept and Archived are the three places to look
for something an agent set aside, and each line there says why it is there;
and a park of something that waited on you, a withdrawn ask, and an ask
closed when you had not written since, done with `bb cow` in a thread, each
leave a notice in the queue until you acknowledge it.

### What cow cannot guarantee

What was tried, on bb 0.49.0, from inside a sandboxed agent's own turn (a
fixture thread running one script of ordinary commands in bb's command
sandbox). `npm run e2e` runs it every time: see "the probe" in
`scripts/e2e.mjs`.

| Route | Result |
| --- | --- |
| the old methods (`cap_create`, `cap_ack`, `permission_decide`, `ask_answer`, and since 0.2.1 `seen_set`, `dismissal_set`, `brief_read`), by `curl` and by `bb plugin rpc call` | refused: they no longer exist ("has no rpc method") |
| `signed` with no signature: make a capability, acknowledge a notice, delete a capability, decide another thread's permission request, answer an ask, approve a key, mark a reply as seen, dismiss a refusal, mark a brief as read; by `curl` and by `bb plugin rpc call` | refused: "this is something only the person may do, so the call has to be signed by a key enrolled with cow" |
| `signed` with a made-up signature that names the enrolled page's key, for each of those | refused: "the signature does not match the call" |
| what was marked seen, dismissed or read after all of that | unchanged, and nothing in the log. On 0.2.0 the same script marked all three, by both routes, and logged nothing |
| `key_enrol` with a key of its own | accepted as a **request**: it shows in your queue under whatever name the caller gave, and does nothing until an enrolled page approves it |
| creating the reset file | blocked by the sandbox: "Operation not permitted" |
| `bb thread interactions approve <request> <thread>` | **worked**, as bb allows any thread to do; cow flagged it "approved outside cow" |
| opening bb's database, where cow's storage is, for writing | blocked by the sandbox |
| `bb plugin config cow`, to see whether plugin management is reachable | reachable. `bb plugin disable cow` and `bb plugin remove cow`, which would stop cow, were not run |

So, plainly:

- **Prevented: forging your actions through cow.** A sandboxed agent cannot
  make, delete or acknowledge a capability, decide a permission request
  through cow, answer an ask as you, send as you through cow, enrol a key,
  mark a reply as seen, dismiss a refusal, mark a brief as read, or record a
  Main. What cow logs as done by a key was signed by that key.
- **Still only visible: parking, keeping and archiving.** An agent can park,
  keep (through cow's interface) or archive a thread, and that takes its line out of your queue. The line is
  on the Parked shelf or under Archived afterwards, with the reason given.
  The same goes for keeping, through cow's interface: the line is under
  Kept. See the table above. Parking with `bb cow park` from a thread, when
  the thread waited on you, also leaves a notice until you acknowledge it;
  it is not signed, so a caller of the interface can still park without one.
- **Still only visible, or not even that: bb's own commands.** Any thread
  can approve or deny another thread's permission request with
  `bb thread interactions`, and can send a thread a message as you with
  `bb thread tell` once it clears the variable that names it. Those are
  bb's, and cow cannot stop them. An approval or denial made that way is
  flagged "outside cow" on the line and in the queue until you acknowledge
  it. Deciding a request in bb's own chat is flagged the same way, because
  bb records no one for either. A message sent as you is not flagged, and
  it does what a message of yours does: the reply before it counts as read,
  what bb refused that thread stops counting, and an open ask of that
  thread says you have messaged since.
  And `bb plugin config cow` is reachable: a caller that sets the checker's
  model to one that does not exist makes every later check fail, and a
  failed check disputes nothing.
- **What it rests on.**
  - *The browser's key store.* The private key cannot be exported through
    the browser, but it is in the browser profile's files on disk. bb's
    sandbox lets a thread read most of the disk. An agent that parsed those
    files could take the key and sign as you; cow would not know. So could
    anything that drives your own browser, with your profile, to the page.
  - *bb's sandbox.* The reset file, cow's storage and the log are protected
    only by a sandboxed thread not being able to write under bb's data
    directory. A thread in bb's full-access mode is not sandboxed: it can
    create the reset file and be the next to enrol, or rewrite the storage.
    Your page would then say it is not enrolled, and the log would hold a
    reset you did not make, or be missing.
  - *First use.* Whatever opens a cow with no key first is enrolled. Enrol
    your own page before you let agents run.
  - *The plugin staying installed.* `bb plugin disable` and `remove` are
    reachable from a thread.
- **The log is evidence against a caller of the interface, not against
  someone who can write cow's storage.** Its chain of hashes holds no secret:
  a process outside the sandbox could rewrite the whole log so that it checks
  out. A missing or broken log is itself the sign.
- **Requests are watched only while cow runs.** A request raised and decided
  entirely while the plugin was disabled, or reloading, is never seen. One
  that cow saw raised, and finds decided when it loads again, is flagged: cow
  did not make that decision. What is still pending when cow loads is looked
  at then, and allowed if a capability covers it.
- A page left open from before an update keeps the code it loaded. One from
  before signing existed cannot act until it is reloaded.
- cow reads bb 0.49 with the Claude Code provider, as elsewhere on this page.

Capabilities, the log and the notices are for control and for noticing. What
you allow is still decided by what you put in a rule and who you give it to.

## The CLI, for agents

Main is an agent, and it cleans up after the threads it started. `bb cow`
gives it the page's verbs, so its clean-up carries a reason the way yours
does. The commands follow the page's rules and act through the same backend
code, and the page shows what they change at once.

```sh
bb cow status [--main <thread>] [--json]
bb cow archive <thread> [--reason <text>] [--outcome done|partial|redone|dropped]
bb cow outcome <thread> done|partial|redone|dropped
bb cow ledger [--days 14] [--by model|dispatcher|label] [--json]
bb cow spend [--month YYYY-MM] [--main <thread>] [--json]
bb cow park <thread> --reason <text> [--pickup <date|+3d|+2w|text>] [--stop]
bb cow resume <thread>
bb cow next <thread> "<text>" | --clear
bb cow wait <thread> --on <who or what> [--for <what is needed>] [--remind <date|+3d|+2w>] | --clear
bb cow project <thread> [--clear]
bb cow todo add <thread> "<title>"
bb cow todo done <thread> <n>
bb cow todo rm <thread> <n>
bb cow todo list <thread>
bb cow workspace [<folder>] [--json]
bb cow workspace add <folder>
bb cow workspace sync [<folder>] [--only <as>] [--json]
bb cow workspace back <thread> [--json]
bb cow help
```

The `workspace` commands are described in [docs/clone.md](clone.md#the-workspace-file).
`workspace` lists each workspace folder cow knows, whether its
`cow.workspace.json` is approved, changed or missing, and each repository's
last sync (when, exit code), whether it is dirty now, and which commands it
has, never their text. `workspace add` only proposes a folder: its file
waits for your approval on the page. `workspace sync` runs the approved sync
commands; anyone may run it. `workspace back` shows what bringing a thread's
work back would run, for each repository how many commits it has that its
source does not and the command, and runs nothing, whoever calls it: you
bring work back with `B` on the thread's line on the page, signed. After the workspaces, `workspace` lists the clones held back
from removal (see [When the clone is removed](clone.md#when-the-clone-is-removed)):
each one's id, its thread's title, when it was held, why and where it is,
never a command's output. Nothing in the CLI removes one or runs its
teardown: you do, from `W` on the page, signed.

**What a workspace keeps, and where.** In cow's own storage (bb's database):
each workspace folder cow knows, by real path, with the content you last
approved, its hash, when and by which key, and the hash of a notice you
dismissed. In cow's host data folder only
(`~/.bb/plugins/cow/host-data/workspace/runs.json`, mode 0600): per
repository, the last sync, setup, back and teardown run, each with when it ran, how
long, its exit code and its last 20 lines of output, and when its sync last
succeeded; and, for each held clone, `held/<id>.json` beside it (mode 0600),
with why it was held and its teardowns' last lines. Output is never written
to bb's database or to the log.

| Command | Does |
| --- | --- |
| `status` | the overview as text: the queue, then one line per thread with its state, time in state, and what it is doing or waiting on, then the parked shelf, what is to settle (unread first, then oldest first, with what archiving each would leave behind), what is kept, what was archived in the last 2 days, bb's automations with their recent runs (40 listed), and the open threads outside Main (40 listed, newest activity first). A thread that holds capabilities ends `[holds: …]` with their names, and one whose permission request was decided outside cow reads "approved outside cow: …" and is in the queue. An ask of a thread under a parked or kept thread is in the queue, ending "under parked “…”". After the queue, when there are any, "Taken out of the user's queue by an agent, not yet acknowledged by the user" lists the traces about threads under this Main (see "What an agent took out of your queue") |
| `archive` | archives a done or failed thread in bb and records the reason; refused while threads under it are still open. `--outcome` says what a worker came to (see "The ledger") |
| `outcome` | sets or changes what a worker came to, open or archived; never over an outcome you set |
| `ledger` | the ledger's rows and its summary by model, by dispatching thread and by label, for `--days` (14 by default), with tokens, list-price dollars and dollars per done (see "Tokens and dollars") |
| `spend` | the month's (`--month`, this one by default) tokens and list-price dollars under Main: workers, project threads, Main, cow's checker runs, the total, and how many had no usage recorded |
| `park` | sets a thread aside; the reason is required, and `--pickup` is read exactly as the page reads a pick-up |
| `resume` | takes a parked thread off the shelf |
| `next` | sets, or with `--clear` removes, the one line that says what happens next for a thread |
| `wait` | says, or with `--clear` stops saying, that a thread waits on someone other than you; see "Waiting on someone else" |
| `project` | marks a thread as a project, or with `--clear` takes the mark off: it then reads idle, never done, until it is archived |
| `todo add` | adds a piece of work not started to the end of a thread's list; the list holds 12 |
| `todo done`, `todo rm` | take item `n` off the list: its work has started, or it will not be done |
| `todo list` | the list, numbered from 1 |

`status` uses the Main last chosen on the page for the project the command
runs in, unless `--main` names one. Its output is bounded: at most 80 open
threads, 30 parked, 40 to settle, 30 kept, 20 archived and 20 queue entries are listed, and the rest are
counted. `park` refuses a thread whose turn is running unless `--stop` is
given, which stops the turn first, as the page does after asking. A refused
command exits non-zero and says why; every command takes `--json`.

`next`, `wait`, `todo` and `project` may be run by a thread only on itself and on the threads
under it; bb tells the command which thread is calling, and any other
target is refused. `status` shows each thread's note and list, and for a
group what is under it by state.

The CLI has no undo: `bb cow resume` reverses a park, and
`bb thread unarchive` reverses an archive. Answering questions, granting
permissions and dealing with refused ones stay with you, on the page.
`bb cow ask`, `asks` and `brief` are described under "Asks" and "Briefs and
the checker"; `bb cow caps`, `caps log` and `cap request` under
"Capabilities".

The plugin ships a skill, `skills/cow/SKILL.md`, that tells agents about
these commands.

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
