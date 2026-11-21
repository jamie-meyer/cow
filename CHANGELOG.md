# Changelog

What changed for someone who uses cow. Versions are tags in this repository:
`v0.2.1` is the commit `bb plugin install` gives you for a range that allows
0.2.1.

## 0.2.21

- **Caps and stuck checks, shown and never enforced.** cow keeps a small
  record of each running worker's progress, from bb's events: its tool calls
  (items that are not reasoning or messages), when its turns started and how
  long they ran, its last event, what is in progress and since when, when a
  file last changed, and its last five calls as a kind, a hash and a label of
  at most 60 characters (a command's first line, or a tool's name). No
  message text, output, file contents or tool arguments are kept.
- **Caps, from one setting.** `caps` is JSON keyed by label, with `*` for
  workers of any other label or none, each with any of `toolCalls`,
  `minutes` (since the worker's first turn started) and `dollars` (list
  price, known only once a turn has ended). Empty, the default, is no caps.
  A value not in that form is reported on the page, and then no cap applies.
- **Stuck checks, on by default**, for workers only and only while a turn
  runs: the same call 3 or more times in a row (`stuckRepeats`), a turn with
  no event and nothing in progress for 15 minutes (`stuckQuietMinutes`), one
  item in progress for 45 minutes (`stuckLongItemMinutes`); 0 turns each off.
- **A mark and one notice.** A worker over a cap or caught by a check has a
  mark on its line while it is true ("over cap: 41 of 40 tool calls", "the
  same command 4 times", "quiet 22m"), beside its line in `bb cow status`
  and as `watch` in `--json`; and one notice per worker per reason in your
  queue, with the facts cow collected. A click acknowledges it as a signed
  call, and that reason does not come back for that worker. cow's server
  checks when a worker's events change and once a minute on one timer, which
  the usage notices now share. Main and project threads are never marked.
  Nothing is stopped, paused, interrupted or sent.
- **Two more numbers in the ledger row:** the worker's tool calls and its
  working minutes (its turns' lengths, summed). Rows written before read as
  null. Nothing summarises them yet.
- **A worker with threads of its own is still a worker.** A thread under a
  parent, not marked as a project, whose own threads are all archived, can be
  given an outcome and gets its ledger row. One with a thread under it still
  open, a marked project and Main are refused as before; the page draws
  groups as it did.

## 0.2.20

- **A usage line.** One quiet line above the status line, and `bb cow usage
  [--json]`, show every usage window bb reports for each signed-in provider
  on this machine (Claude Code's weekly limit and its per-model one, Codex's,
  any provider's): its label, percent and when it resets. A provider not
  signed in, or that reports no windows, is left out. Then this month's
  list-price dollars of every thread on this bb, and with a budget set, the
  budget and the month-end figure at the current pace.
- **A monthly budget, not a hard stop.** The setting `monthlyBudget` (US
  dollars; empty means none). The pace is the dollars so far divided by the
  fraction of the month gone, from the 3rd day of the month on.
- **A notice before a limit, once.** When a window reaches
  `usageWindowPercent` (default 80), when the month's dollars reach 80% of
  the budget, or when the pace goes over it, cow puts one notice in your
  queue with the facts: once per window per reset period, once per rule a
  month. A click, or its hint, acknowledges it as a signed call, and it does
  not come back until the next period. cow's server checks every five
  minutes, with the page open or not. With `usageNotify` on (the default)
  the same text is sent as a notification through bb's push-notifications
  plugin. Nothing is ever paused or stopped, and no thread is sent anything.
- **Long-lived threads counted right.** A new provider process starts its
  running total from zero under the same session; on a thread whose context
  only grows, cow took the new total for the old one carried on and counted
  only the difference, so a busy Main showed a fraction of what it used.
  From 0.2.20 a `thread/identity` (a new process) makes the next total count
  in full. Months already counted stay as they were, and what bb dropped
  before cow first read a thread cannot be got back: `bb cow spend` now
  says so.

## 0.2.19

- **Tokens in the ledger.** Each worker's row now holds the tokens it used,
  as bb recorded them: input apart from the cache, cache reads, cache writes
  and output. They come from bb's own usage event at the end of each turn;
  no transcript is read. A row written before 0.2.19, or for a thread bb
  recorded no usage for, reads as "usage unknown", never as zero. Usage
  that arrives after a worker was archived brings its row up to date.
- **Dollars at list price.** `bb cow ledger` and the `L` sheet give every
  group, in every grouping, its tokens, their dollars at the providers'
  published list prices, and dollars per done: the group's dollars, every
  outcome, divided by how many came to done. `--json` carries the numbers.
  cow keeps a small table of list prices for Claude Code's and Codex's
  models, each with the date it was taken and the page it came from; a
  model with none shows tokens and no dollars. The setting `listPrices`
  changes or adds prices, and since dollars are worked out when shown, a
  change applies to rows already written. **Every dollar figure is an
  estimate at list price, not a bill**: on a subscription you are not
  billed this.
- **This month, everything.** `bb cow spend [--month YYYY-MM]`, and a part
  of the `L` sheet, give the month's tokens and list-price dollars for every
  thread under Main, archived or not, split into workers, project threads,
  Main itself and cow's checker runs, with the total and how many threads
  had no usage recorded. cow keeps what it has read of each thread's usage
  in its own storage and reads it as each turn ends, so opening the sheet
  asks bb only about threads that changed.
- **The checker never runs where someone's work is.** When bb will not make
  it an empty workspace on its primary machine (because that machine is not
  connected), the checker gets one on the submitting thread's machine
  instead of starting in that thread's checkout. With neither, the check
  fails with a reason that says how to run it again.
- **A checker that used a tool says which.** The failed check's reason
  names the tools when bb's timeline gives them, and points to the
  checker's thread.
- The note about an earlier check that was run again unread counts claims
  and task checks apart: "contradicted 1 claim and disputed 1 task check".

## 0.2.18

- **The checker sees the task and the diff, not the agent's framing.** It is
  no longer shown the brief's summary or the agent's label for any claim:
  it gets each claim's id and text, the evidence, and what was left undone.
  Disputes are still worked out from its verdict and the agent's label
  together, afterwards. On the sheet and in `bb cow brief show`, each claim
  now gives the checker's verdict and what the evidence shows first, and the
  agent's own label after.
- **The task.** cow reads the first message the submitting thread was
  started with and shows it to the checker (up to 12,000 characters). Each
  check of its "Done means" section (a heading or a bold lead-in) is
  answered for too: shown, not shown, or cannot tell with what would settle
  it. A check not shown, or that cannot be told, is a dispute and puts the
  brief in your queue. A reply that leaves a check out is tried once more,
  like any unreadable reply.
- **The diff.** cow collects, from the submitting thread's git checkout on
  its own machine, the base it compares against (the merge base with the
  environment's base or default branch), every changed file with its status
  (uncommitted and untracked included), and the diff, cut to 60,000
  characters in all and 12,000 a file so that one large file does not hide
  the rest. Lock and binary files, and files that may hold secrets (`.env`,
  keys and the like), go by name only. Every cut is named in the prompt.
  With no environment, no git checkout, or git failing, the check still runs
  and the checker is told there is no diff. The new `checkerDiff` setting
  (on) turns it off; the diff is sent to the checker's model. The checker
  may also name changed files no claim accounts for: the sheet shows them as
  a note, not a dispute.
- **A dispute with no model.** A diff that modifies, deletes or renames a
  test file that existed at the base, or adds, changes or deletes the
  configuration of CI, a linter, a formatter, a type checker or a test
  runner, is disputed as having "changed what decides whether its checks
  pass", naming the files. It counts for the queue like any other dispute,
  and stands even when the check fails. A new test file alone is not
  flagged. The rules are listed in the reference.
- **The record says what the checker was shown**: whether it had a task and
  how many checks, the base revision, the changed files, what was cut, and
  the flagged files. The text it was shown is kept beside the record, so a
  run of the check again is shown the same material. Briefs stored by
  earlier versions read and show as they did.
- The checker's permission mode was described wrongly in the code: it is
  `accept-edits`, the narrowest of bb's three, which asks rather than
  refuses. The mode is unchanged.

## 0.2.17

- **Teardown, and no quiet loss of a clone's work.** The workspace file takes
  a `teardown` command per repository and for the workspace folder, approved
  like `sync`, `setup` and `back` (the review lists it as a command that would
  newly run). When bb removes a clone, five minutes after its last thread is
  archived, each teardown runs first, while the clone still exists, from the
  content you approved: repositories in the reverse of setup's order, then
  the workspace folder's. Use it to save leftover work and release what setup
  made, such as a database or a port.
- **A clone that might hold work is held, not deleted.** Before removing a
  clone, cow looks at each git repository in it without a teardown: anything
  uncommitted or untracked (ignored files do not count), or commits on its
  branches that its source repository does not have (work already brought
  back does not count). A clean teardown is taken as having saved what
  mattered. If a teardown failed or ran past its time limit, or a repository
  without one holds unsaved work, the clone is moved aside, in one rename, to
  `held/` in cow's host data folder, and bb is told it was removed. A notice
  in your queue says which and why; `W` lists the held clones with their
  path, so you can look inside. There `Enter` shows what the teardowns
  printed, `t` runs the approved teardown again (and removes the clone when
  nothing holds it any more), and `d` removes it for good after a `y`
  confirmation that names what would be lost. Each is signed.
  `bb cow workspace` lists held clones; nothing in the CLI removes one.
- **Ledger labels: is each kind of job on the right model?** A dispatching
  thread can give a worker a label of its own choosing, one short word for
  the kind of job (`lookup`, `draft`, `code-change`): `bb cow label <thread>
  <label>`, or `--label` on `bb cow archive` and `bb cow outcome`. Who may
  set one is who may set an outcome, and a thread never overwrites yours.
  The ledger's row has one more key, `label`; older rows read as none. `L`
  and `bb cow ledger` group by label too, with "(no label)" for the rest and
  each label's workers by model beneath it; `b` in the sheet, and
  `--by model|dispatcher|label` on the command, show one grouping.
- **The capabilities sheet keeps its place.** Acknowledging, deleting,
  approving or refusing the line under the cursor, or a change from
  elsewhere while the sheet is open, leaves the cursor on the line that
  slides into its place (or the last one), not back at the top.
- **The filter's Enter unfolds the line it keeps.** `/name`, Enter, then `j`
  reaches that line's first subthread even when it was folded.

## 0.2.16

- **Open cow from anywhere.** Ctrl+Option+C (Ctrl+Alt+C off macOS) opens
  cow's page from wherever you are in bb: a thread's chat, another plugin's
  page, settings. It is a bb command, "🐄 cow: open cow's page", so it is in
  the command palette too and you can rebind it in bb's keyboard settings.
  The window is not reloaded, and bb's back takes you to where you were. On
  cow's page it does nothing: the open chat and the selection stay.

## 0.2.15

A workspace file: your repositories kept in sync, set up in each clone, and a
thread's work brought back, with commands you write and approve.

- **`cow.workspace.json`.** A file at the top of a workspace folder names
  the repositories a copy-on-write thread brings and, for each, optional
  `sync`, `setup` and `back` commands of your own: git, a stacking tool,
  anything. It is read strictly: a typo in a field name is refused, and
  every problem names its field. See [docs/clone.md](docs/clone.md#the-workspace-file).
- **Nothing in it runs until you approve it.** The commands run with your
  full access, outside any sandbox, and the file sits where agents can
  write. So cow keeps the content you last approved and runs only that.
  `bb cow workspace add <folder>` proposes a folder; a notice in your queue
  opens the file in the reader, the commands that would newly run first,
  then the change. `a` approves exactly what is shown (refused if the file
  changed since), `x` dismisses it until it changes again. Each approval is
  in the log with the content's hash.
- **Sync.** `bb cow workspace sync` runs each repository's approved `sync`
  in it, then the workspace folder's own, one at a time, under a five-minute
  limit; a repository with uncommitted or untracked changes is skipped and
  left alone. Anyone may run it, so an automation can keep your clean bases
  current. With `syncBeforeClone`, a repository not synced recently is
  synced before a thread clones it; if that fails, the thread still starts,
  with a warning.
- **Starting a thread from the file.** `--environment-inputs '{ "workspace":
  "<folder>", "bring": ["api"] }'` takes the repositories, read-only paths
  and excludes from the approved file. Each repository's `setup` runs once in
  the clone before the thread starts; one that fails fails the thread with
  its last lines of output, and the clone is removed.
- **Bringing work back.** `B` on a copy-on-write thread's line names each
  repository with new commits and the approved `back` command it would run;
  `y` runs them in the sources, signed by your page's key. That is the only
  way a back command runs: `bb cow workspace back <thread>` shows the same
  plan (each repository's new commits and the command) and runs nothing,
  whoever calls it, so no process can pass for you to run one. A thread
  whose work is ready says so with `bb cow ask`.
- **Seeing it.** `W` lists each workspace and repository with its last sync,
  whether it is dirty and which commands it has; `s` syncs the selected
  repository, `S` all, `Enter` shows the last output, to you only (also
  while a change to the file waits on you), and `r` opens that change.
  `bb cow workspace` shows the same without the output.
- **A narrow page keeps its list's room with two notices showing.** The
  notices above the list (the key's banner, and an aside such as "bb is
  outside the version cow was tested on") now share one height limit
  instead of each having its own, so one more notice scrolls inside that
  space instead of shortening the list.

## 0.2.14

A check that can always start, and a failed rerun that loses nothing.

- **Checking a brief after its thread is archived works.** The checker reads
  only its prompt, so its thread now starts in an empty personal workspace
  of its own (in bb's personal project, removed with it) instead of the
  submitting thread's worktree. A brief whose thread is archived and whose
  worktree bb has removed is checked like any other. The checker still uses
  no tools, and an answer from one that did is still thrown away.
- **A failure that says what failed.** If there is nowhere to start a
  checker, the check says "the thread's environment is gone, and there is
  nowhere else to start a check", with what bb said. "To check it on another
  provider" is now added only where another provider could help: not signed
  in, no such provider or model, billing, a usage limit or budget, an
  overloaded provider, a brief too long for the model.
- **A check run again that fails keeps the one before.** When no run of the
  new check gives a usable answer, the earlier check stays, verdicts and
  all, and the brief says above it "Checked again on <date>: that attempt
  failed (<why>); the check below is from <date>". A check run again that
  answers replaces the earlier one, as before.
- **The note about an earlier check says what it counted.** A claim the
  agent called checked and the checker could not confirm keeps a brief in
  front of you, and was counted as "disputed". The note now says "could not
  confirm 5 claims", "contradicted 1 claim", or both.
- **Not recoverable.** A check that a failed rerun overwrote before this
  version cannot be brought back: cow did not keep it. Run the check again;
  for a brief whose thread is archived that now works.

## 0.2.13

A copy-on-write workspace for a thread, on macOS.

- **Start a thread in a clone of a whole workspace.** cow now offers bb an
  environment, `cow-clone`, that gives a thread an APFS clone of a workspace
  folder with the repositories it needs cloned inside it:
  `bb thread spawn --environment-provider cow-clone --environment-inputs
  '{"source": "…", "bring": [{"path": "…", "as": "…"}], "readOnly": ["notes"]}'`.
  A clone of tens of thousands of files takes well under a second and costs
  almost no disk until something is written.
- **What a clone holds.** Each repository goes on a branch named for the
  thread, with its uncommitted changes. Secrets such as `.env` files and keys
  are never cloned. Paths you name are made read-only, so notes can be
  context a thread reads and does not edit.
- **What is refused.** A linked git worktree, and a repository that borrows
  objects from another, are not independent once cloned, so they are refused
  with the reason. A source on another volume is refused; nothing is ever
  copied the slow way.
- **Removing it.** The clone goes with the thread's environment. Only the
  clone's own folder is ever deleted.
- **Not yet.** A command to bring a thread's work back (for now, `git fetch`
  from the original, as [docs/clone.md](docs/clone.md) shows), a list of
  repositories kept by cow, and a form in bb's New Thread dialog.

## 0.2.12

The checker runs on a provider that works, and says why when it cannot.

- **The checker runs where your thread runs.** With cow's checker settings
  empty, a brief is now checked on the provider and model of the thread
  that submitted it, instead of on bb's default provider. bb's default can
  be a provider that is installed and listed as ready but cannot run here,
  for instance because it is signed out; then every check failed.
- **Settings still come first.** `checkerProvider` and `checkerModel` in
  cow's settings are used when set, and `bb cow brief check <thread>
  --provider <id> --model <id>` overrides both. A provider given without a
  model runs on that provider's default model.
- **The check says where it ran.** The sheet and `bb cow brief show` name the
  provider and model, and say "as the submitting thread ran" when both were
  inherited. `--json` has `provider` and `chosen` (`given`, `setting`,
  `inherited` or `default`) beside `model`.
- **A failure says why.** Instead of "the checker's turn failed", a failed
  check now says the provider and model it was started on, the cause where
  bb recorded one ("the provider is not signed in", "the provider does not
  have that model"), what bb said, and how to run it elsewhere, for example:

  > the checker's turn failed on codex, its default model: the provider is
  > not signed in (bb said: "…"). To check it on another provider: bb cow
  > brief check thr_… --provider \<provider\> --model \<model\>

  A provider that also fails is a failed check with its cause; cow does not
  quietly try another.
- **Briefs whose check already failed stay failed** until they are checked
  again. Press `c` in the brief, or run `bb cow brief check <thread>`: with
  your settings empty it now runs on that thread's own provider.

## 0.2.11

What each finished worker came to, and a ledger of it.

- **An outcome when you archive a worker.** `e` on a finished worker (a line
  that is done, waiting or kept, and not a project, Main or an automation's
  run) first asks what it came to: `1` done (the work was used as it came
  back), `2` partial (some of it was used, or it needed a second worker),
  `3` redone (it was wrong, and you or another thread redid it), `4`
  dropped (it was not used). `Enter` leaves it unsaid; then the reason, as
  before. One extra key, never required.
- **Changing it later.** "Redone" is often only known afterwards: `o` on a
  line under Archived or To settle sets or changes the outcome, and the line
  reads "came to: …". It is signed by your page's key and written to cow's
  log, like everything else only you may do.
- **Agents give one too.** `bb cow archive <thread> --outcome <one>` when a
  thread archives a worker it dispatched, and `bb cow outcome <thread>
  <one>` to change it, on an open or an archived thread. The skill tells
  agents to be honest, and that "done" means the work was used as it came
  back. Every outcome records who judged it, you or a thread, and each
  change keeps who made it and when. A thread can never overwrite an outcome
  you set: it is refused, and told so.
- **A ledger.** Each worker archived through cow gets one row in cow's own
  storage, kept after the thread is gone: its model and reasoning effort,
  its time to first report, how many times you and other threads steered it
  before that report, how many turns it ran, its outcome and who judged it,
  and who archived it. No titles, prompts, message text or reasons.
  Threads archived before this version have no row.
- **Reading it.** `L` opens a sheet with the last 14 days by model and by
  dispatching thread: how many workers, how many of each outcome and how
  many unsaid, the median time to first report and steers before it, and how
  many you judged; then the latest rows. `q` or `Esc` closes it. `bb cow
  ledger [--days 14] [--json]` gives the same with every row. A group of
  fewer than 5 workers is counted, and said to be too small to compare.
  `bb cow status` shows an archived worker's outcome at the end of its line.

## 0.2.10

A card with what bb and other plugins know about a thread, a way to delete
an automation, and the sections in the order you look at them.

- **A context card for the selected thread.** At the bottom of the right
  column, just above the legend, the selected line's thread shows its pull
  request (number, title, state, checks and review, with a link), its
  changed files (how many, the first five opening in the reader), and any
  section another plugin adds for it, such as a whole stack of pull
  requests with each one's CI and review state. It follows the cursor, so
  you can check stacks by walking the queue. With a chat open, the same
  card is at the top of the pane, folded to its section titles when it is
  long; a click or a hint on a title unfolds it. A thread with nothing to
  show has no card. `v` hides it in the window, and the window remembers.
  Plugin authors: any plugin can add sections by offering one discoverable
  method, `cow_card`; the contract, its limits and an example are in
  [docs/reference.md](docs/reference.md#the-context-card). It is cow's own
  and may change before 1.0.
- **Delete an automation with `e`.** On an automation's row, `e` now
  deletes it, for the one-time reminders you no longer need. It asks first,
  naming it, saying whether it is enabled and when it would next run, that
  its past run threads stay, and that it cannot be undone: `y` deletes, any
  other key cancels. Only you can do it: it is signed by your page's key,
  and written to cow's log. `e` on a run still archives the run.
- **A new order of sections.** The tree, Parked, To settle, Kept,
  Automations, Outside Main, and Archived last, on the page, for `j`, `k`
  and `/`, and in `bb cow status`.
- **More room for the list on a narrow page.** Below 900 pixels wide, the
  verb bar keeps to two rows, each scrolling sideways instead of wrapping
  (every verb keeps its key), and a notice about this page's key is shorter
  and scrolls inside itself.

## 0.2.9

Two things that were harder than they should have been.

- **A request for a capability says how to decide it.** When an agent asks
  for a capability (`bb cow cap request`), its line and its queue entry now
  read "asks for a capability to write under /srv/reports: press a to allow
  or refuse" (or "to run “npm test”"), and the next move says "press a to
  allow or refuse". With the line selected, `a` comes first in the verb bar,
  as "allow or refuse". Its card says "Capability request", which thread it
  is for, what it asks for, and why in the agent's words, and shows both
  choices at once: `1` allow it, `2` refuse it. `1` now opens the steps
  straight away, without `Enter`: you can still narrow or widen what it
  covers, and nothing is granted until you confirm the last step. The card
  says the capability lasts until you delete it, not for this once only.
  `2`, then `Enter`, tells the agent no.
- **Threads outside Main can be archived with a reason.** `e` on a line in
  Outside Main asks for a reason, as on any line, and archives it; `u` takes
  it back. The archived thread is listed under Archived with its reason for
  two days, like any other. For agents, `bb cow archive` took every thread
  with no parent for Main and refused it ("Main cannot be archived from
  here"). Now only the thread that is Main gets that refusal. The thread
  that is Main may archive a thread outside Main with a reason; any other
  thread is refused, and told that only Main, or you, archive those. A
  running thread, or one bb is asking a question, is still not archived,
  and the refusal now says which. `bb cow park` on a thread outside Main
  says to bring it under Main first, instead of calling it Main.

## 0.2.8

Agents may set things aside that were waiting on you. Until now some of that
left no trace on the page.

- **You are shown what an agent takes out of your queue.** When an agent
  parks a thread that was waiting on you (an open ask, one of bb's own
  questions or permission requests, a refused permission, a failure, a
  brief with disputes, or a reply addressed to you), withdraws an ask, or
  closes an ask as answered in chat when you have not written to that
  thread since it asked, a notice appears at the top of your queue. It says
  which thread did it, to what (and for an ask, its question), what it
  claimed (the park's reason, or the answer it says you gave), and how long
  ago. It stays until you acknowledge it: `C`, then on it `Enter` opens that
  thread's chat and `Space` acknowledges. Each one is also in the log
  (`Tab` in the sheet, `bb cow caps log`), and `bb cow status` lists the
  ones you have not acknowledged. Parking a thread that waited on nothing,
  closing an ask after you did write to the thread, and anything you do
  yourself, show nothing new.
- **An ask under a parked or kept thread is in your queue.** A thread under
  a parked or kept thread is set aside with it, and its open ask used to be
  set aside too: it showed only in `bb cow asks`. Now it is in the queue
  like any ask, listed after the Parked shelf, and says which parked or kept
  thread it is under. Answering it resumes nothing.
- **An automation's run that bb refused a permission is in your queue.** A
  run blocked on a permission it was never asked for showed as blocked on
  its line in the Automations section, and nowhere else. It is now in the
  queue like any blocked thread, and `a` grants, asks again as you, or
  dismisses it.

## 0.2.7

- **A project's reply to its own threads' reports no longer enters your
  queue.** A reply now waits on you only when it ends the thread's newest
  turn and you started that turn (or said something into it while it ran),
  for every thread: Main, projects and workers alike. When a thread under a
  project reports back, the project's answer to that report ("noted", a
  status line) no longer reads "replied to you". Instead its line stays idle
  and gets a small dot after its name, quietly coloured, meaning unread;
  Main's heading gets the same dot. Opening the chat or `Space` clears it,
  and `u` brings it back. `bb cow status` says `[unread]` on such lines.
  What a project needs from you still comes in: its asks (`bb cow ask`),
  bb's own questions and permission requests, refusals, failures, briefs
  with disputes, and your own conversations with it.
- **Main is read like every other thread.** It used to go by bb's own
  unread record; now it goes by the rule above and cow's record of what you
  have seen, so reading Main's reply in bb's own chat, outside cow's page,
  no longer clears it there (a message you send Main does).
- **bb's back and forward keys walk the chats you opened on the page**
  (`Cmd+[` and `Cmd+]`), closing the pane included. The page's address
  names the open chat, so a reload reopens it. A chat reopened that way, or
  by back and forward, marks nothing as seen: only you opening it does. An
  address naming a thread the page does not know (deleted, mistyped, a link
  from another machine) opens nothing and says so; an archived thread's
  chat opens as `Enter` on its line would.

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
