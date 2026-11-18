# Changelog

What changed for someone who uses cow. Versions are tags in this repository:
`v0.2.1` is the commit `bb plugin install` gives you for a range that allows
0.2.1.

## 0.2.6

Another plugin can know things about a thread that cow does not: its pull
request, whether its checks are green, what to do about it. bb shows those
on a thread's row in its own sidebar and in the thread's menu; on cow's page
they were a click away, inside each thread.

- **Other plugins' badges at the end of a line.** Every badge another plugin
  registers for a thread's row in bb (bb's own pull-request status is one)
  shows at the end of the thread's line, after what is next: in the tree,
  Parked, To settle, Kept and an automation's runs. The line stays one line:
  badges take what room is left and are cut off with an ellipsis, and never
  push cow's columns. With no such plugin installed the page looks as it
  did. A badge never changes a line's state, section or place in the queue,
  a badge that fails takes only itself out, and none show on Outside Main
  lines or on an archived thread's line.
- **`.` lists other plugins' actions for the selected line**, each with its
  label, detail, the plugin that offers it, and a digit or letter to run it;
  `f` hints the rows. Picking one runs it in that plugin's own code, under
  its authority: cow signs, sends and records nothing for it. A dimmed
  action is turned off by its plugin and cannot be picked; one with choices
  shows them next. The message line says when the plugin has finished. Esc
  closes the list. The verb bar shows `. more` only on a line that has
  something to list.
- These rest on parts of bb's plugin interface that bb marks experimental:
  see "Limits, and what cow rests on" in the README.

## 0.2.5

Each run of a bb automation is a new thread with no parent, so cow never
showed it: runs of a nightly job or a daily check piled up out of sight,
and were found only in bb's sidebar.

- **Automations.** A new section, after Archived and before Outside Main,
  folded by default with its count; `h` and `l` on its heading fold it, and
  the window remembers. One row per automation: its name, its project when
  that is not Main's, when it runs next in plain words ("in 3h", "tomorrow
  09:00", "paused", "ran once"), and what its last run came to and how long
  ago. For an agent automation that is what its run's thread came to, not
  only that the turn ended. A failed run says the first line of its error,
  in the failed colour; nothing else in the section is coloured.
- **Its runs, folded under it.** `l` on an automation's row shows its
  recent run threads as ordinary lines, newest first, at most five, with a
  count of older ones. `Enter` on a run opens its chat; on the row, the
  latest run's chat, or for a script automation what its last run printed,
  in the reader. `e` archives a run as any line.
- **A run that needs you is in your queue**, like any thread: bb's own
  question or permission request, or an open ask. A finished run is not, is
  not under To settle, and is never coloured.
- **View only.** cow does not pause, resume, run or change an automation,
  and never moves a run under Main. Runs listed here are no longer counted
  again under Outside Main.
- **`/`** finds automations and their runs while folded. **`bb cow status`**
  has an "Automations" heading with the same rows, and `--json` an
  `automations` list.
- Without bb's automations plugin, or when it does not answer within a few
  seconds, there is simply no section.

After updating, reload any cow page that was open.

## 0.2.4

Open threads with no parent were on no page: old work, threads started by
hand, forks, work left behind when bb archived its parent. The page showed
only what is under Main, so they could be found only by looking through bb's
sidebar.

- **Outside Main.** A new section at the bottom of the page, after Archived,
  lists every open thread with no parent that is not Main or above it, in
  every bb project. It is folded by default and shows its count; `h` and
  `l` on its heading fold it, and the window remembers. Each line gives the
  title, its project when that is not Main's, how long since it last did
  anything, and whether it is running, wants an answer or is at rest. A
  thread with threads under it is one line, counting them. Nothing in it is
  coloured or in your queue. Threads a plugin started, such as an
  automation's runs, and other projects' Mains are only counted. `Enter`
  opens a line's chat, and `/` finds its lines while it is folded.
- **`A` brings a thread under Main.** On a line in Outside Main, `A` and
  then `y`. The confirmation says what happens: bb gives Main a short
  notice, so Main starts a turn, and the thread's notifications to Main are
  set to "stuck", so it does not wake Main each time it finishes a turn.
  The thread then reads as any other, in the tree or under To settle, and
  the cursor follows it. A reply bb had as read stays read. `u` puts back
  its parent, its sidebar section and its notification setting exactly as
  they were. When bb refuses (the tree would be too deep, or Main is
  archived), the page says so plainly. Agents use bb's own
  `bb thread update --parent-thread`.
- **`bb cow status`** has an "Outside Main" heading with the same lines, and
  `--json` an `outside` list, with `outsideNotListed` counting what is left
  out.
- **A worker handed a thread no longer reads "replied to you".** A worker
  that an agent started, and that then had a thread moved under it, became
  a group head, and a group head's every reply was yours: its final report
  sat in your queue and `bb cow archive` refused it. Now a thread that bb
  has told a thread was moved under it, that you have never written to, and
  that is not marked as a project,
  is read as the worker it is: idle, out of the queue. And the turn bb
  starts only to say a thread was moved under it or away ends in no reply
  for anyone.

After updating, reload any cow page that was open.

## 0.2.3

Finished threads used to pile up: once read, a worker moved to Done and,
after two days, was only counted. Replies nobody had read sat in the queue
for weeks. This release gives each finished thread a place to be settled,
and a quiet shelf for the ones you mean to keep.

- **Done is now To settle.** Every finished thread that is not archived is
  listed there, however long ago it finished: nothing is hidden by age, and
  "N older, not listed" is gone. Each one waits for one decision of yours:
  `e` archives it with a reason, `p` parks it, `z` keeps it, `Enter` and `i`
  carry on with it. Lines with a reply you have not seen come first, marked
  unread, then the oldest. A line's age turns amber after 3 days and red
  after 7, and the heading's count takes the colour of its oldest line, but
  age never puts anything in your queue. Each line says what archiving it
  would leave behind (a reply you have not seen, an open ask, a brief not
  read). The section folds with `h` and `l` on its heading, and the window
  remembers. What you archive is listed under **Archived** for 2 days.
  A finished member of a group stays in its group for 2 days, then moves to
  To settle instead of being only counted.
- **A job's report no longer enters your queue.** A reply at the end of a
  turn you did not start (a worker's final report, a turn another agent
  started) goes to To settle, marked unread. A reply to a message of yours
  still waits for you in the queue, as do Main's, a project's, asks,
  questions, permission requests, refusals, failures and disputed briefs.
  cow tells your turns from others' by bb's record of who sent each prompt.
  A reply you have not read no longer turns "stuck" after a week: the
  thread is at rest.
- **Keep: a quiet shelf.** `z` on a line that is not running keeps it, with
  a few words or none. It goes to the **Kept** section, folded by default,
  never coloured, never in the queue, with no reminder of any kind: for a
  thread you are thinking in, or an idea you may come back to in months.
  Only what truly needs you shows through, as on a parked line: its open
  ask. It comes off the shelf by itself when it starts a turn, as when you
  type to it; `z` takes it off too, and `u` takes back either. `/` finds kept
  lines while the section is folded, and `bb cow status` lists them under
  their own heading. There is no command for agents to keep a thread.
- **Thread ids keep their underscores.** A line that quoted `thr_x` showed
  `thrx`; emphasis is still stripped.

`bb cow status --json` now has `settle`, `kept` and `archived` in place of
`done`, and its `omitted` counts follow. After updating, reload any cow page
that was open. The new note is one more key in cow's notes on a thread.

## 0.2.2

Three things from using cow every day.

- **Waiting on someone else is a state of its own.** A thread whose next
  move belongs to a reviewer, CI or someone outside the team used to read
  idle or done, or sit in your queue with its reply. Now its agent says so
  with `bb cow wait <thread> --on "the reviewer"`, or you do with `w` on its
  line. The line keeps its place, marked ◷, and reads "waiting on the
  reviewer · 3d"; it is not in your queue. Anything that really needs you
  (an ask, a permission request, a refusal, a failure, a disputed brief)
  still shows first. It clears by itself when the thread starts a new turn,
  and when you park or archive it; `w` clears it too, and `u` takes back
  what `w` did. Give it a reminder (`--remind +3d`, or a day) and it comes
  back to your queue on that day as "still waiting on the reviewer after 3
  days", where `a` keeps it waiting or takes it back. The skill tells agents
  to use it instead of a next note that says who they wait on. Like `next`,
  it is not signed: see "What is not signed" in `docs/reference.md`.
- **A link to a thread in the chat opens it in cow's pane.** Clicking a
  thread mentioned in a message, or the parent named above the composer,
  used to leave cow for bb's own chat page. Now the pane switches to that
  thread, as `Enter` on its line would, and the cursor moves to its line.
  `Esc` goes back to the chat you came from before it closes the pane. A
  thread that is not under this Main opens too, and the pane says so.
  Cmd, Ctrl, Alt or Shift with the click leaves it to bb.
- **A line you mark seen stays where it is.** `Space`, or opening its chat,
  used to send a finished worker to Done at once, which read as the thread
  disappearing. It now stays in place, dimmed, with its new state, until you
  reload the page or park or archive it. Nothing stored changes: this is how
  the page shows it.

After updating, reload any cow page that was open. Nothing stored changes
shape; the new note is one more key in cow's notes on a thread.

## 0.2.1

What takes a line out of your queue is now yours alone to do.

- **Marking a reply as seen, dismissing a refused permission and marking a
  brief as read are signed**, and so is taking each back. In 0.2.0 they were
  plain methods of cow's interface, so any local process, a sandboxed agent
  included, could make its own reply, refusal or disputed brief leave your
  queue. Now they are refused without a signature from an enrolled key, by
  every route, and each one done is in the log with the key that signed it.
  Opening a chat or a brief from the page, which marks these as a side
  effect, signs the mark the same way.
- **Recording which thread is Main is signed too.** A window keeps its own
  Main as before, but where a new window starts could be changed by any
  caller, and a new window could then open on a tree that is not yours.
- **Running a brief's check again cannot take it out of your queue.** A new
  check used to replace the old one outright, so a check that failed, or
  came back clean, removed a dispute you had not read. Now the brief keeps
  waiting, and says an earlier check disputed it, until you open it.
- **A page whose key is not enrolled** still reads everything. `Space`,
  dismissing a refusal, and opening a chat or a brief there say why nothing
  was marked. Choosing a Main there changes that window only.
- **Every method that is not signed is listed**, with what an agent calling
  it could hide or change, in `docs/reference.md`. Parking and archiving
  stay open to agents and still take a line out of the queue: the Parked
  shelf and Done are where such a line is, with its reason.
- The log now has an entry for each of these marks, so it grows with use.

After updating, reload any cow page that was open: a page from 0.2.0 can no
longer mark anything seen or read. Nothing stored changes shape.

## 0.2.0

Ready for a machine that is not the one cow was written on.

- **Install from GitHub.** `bb plugin install 'git:https://github.com/jamie-meyer/cow.git@^0.2.0'`
  installs a tagged release; `bb plugin update cow` moves to the next one in
  the range. Mains, notes, asks, briefs, capabilities and enrolled keys are
  kept across an update.
- **A first run that explains itself.** With no Main chosen the page says
  what cow is, what a Main is and what to do, above the list to choose from.
  The notice shown when a page's signing key is first enrolled is two
  sentences, and says where the keys are listed later.
- **The legend (`?`) is rewritten.** It starts with what the page is, groups
  the keys by what you are doing, and scrolls with `j` and `k`.
- **Fixed: a notice above the list took most of the page.** The first-use
  notice, or the one for a page that is not enrolled, could take more than
  half the window and squeeze the list of threads. The list now always keeps
  the free height; a notice is as tall as its text and scrolls beyond a few
  lines.
- **Refusals say what to do instead.** A verb that does not apply, and a
  `bb cow` command that is refused, name the key or command that does.
  Empty sections say what would fill them.
- **`bb cow status` with an archived Main** says the Main is archived and how
  to choose another or bring it back, instead of a bare error.
- **Quiet notes, said once.** On a bb outside the version cow was tested on,
  the page says so. When cow's own theme is not the active one, the page
  mentions it and how to turn it on. Each can be dismissed, and stays so in
  that browser.
- **Removing completely.** `scripts/clear-stored.mjs` deletes what
  `bb plugin remove` leaves in bb's database; the README gives the same as
  one `sqlite3` command.
- The README is rewritten for someone arriving from GitHub, with a section
  on what cow stores, what leaves the machine, and what its signing does and
  does not protect. The longer reference moved to `docs/reference.md`.

Nothing stored by 0.1.0 changes shape: 0.2.0 reads it as it is.

## 0.1.0

The first tagged version.

- **One page for everything Main has delegated.** Every thread under a Main
  thread as one line: its state, how long it has been in it, what it is doing
  or waiting on, and what moves it next. Groups fold; long-lived threads are
  projects that read idle, never done.
- **A queue of what waits on you**: asks, questions, permission requests,
  permissions bb refused without asking, failures, briefs with disputes,
  replies addressed to you, parked work that has come back.
- **Keyboard first, in the manner of vim**: `j` `k`, `/` to filter, `f` for
  letter hints on everything clickable, and one key per verb: answer, park,
  resume, stop, archive with a reason, undo.
- **Answering from the page**: an agent's questions, bb's permission
  requests (allow once, for the session, deny, deny with a reason), and the
  refusals bb makes without asking.
- **Asks and briefs for agents.** `bb cow ask` puts a question in front of
  you until it is answered. `bb cow brief submit` reports a finished job as
  claims with evidence, and a separate checker audits it before you read it.
- **Parking**: set work aside with a reason and a pick-up date; it comes
  back to the queue by itself.
- **Capabilities**: named grants (write under one directory, run one
  command) that answer bb's permission requests "allow once" for the threads
  you choose, with a log of everything allowed.
- **Signed calls.** What only you may do on the page is signed with a key
  the browser holds, so an agent cannot do it through cow.
- **A reader** for files named in a chat, a brief or an ask, read with the
  keyboard.
- **The `bb cow` CLI and a skill** that tells agents how to use it.
- **A theme**, paper and ink, for the whole of bb.
