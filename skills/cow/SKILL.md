---
name: cow
description: Ask the user a question so it stays in front of them (`bb cow ask`), report a finished job as a brief an independent checker audits (`bb cow brief submit`), see or ask for a capability to write outside your workspace or run a command outside the sandbox (`bb cow caps`, `bb cow cap request`), record why a thread is parked or archived and what a worker came to (`bb cow archive --outcome`, `bb cow outcome`), say what is next for your thread or who other than the user it waits on (`bb cow wait`), and read the overview of every thread under Main. Use whenever you have a question or decision for the user, when you finish a job, when you need to write outside your workspace or run something bb's sandbox refuses, when cleaning up or setting aside threads you started, when you end a turn with work still planned or waiting on a reviewer, CI or someone else, or when asked what is waiting on the user.
---

# cow: notes on the threads you started

cow is the user's overview page for one long-lived Main thread and every
thread it has started. The user parks and archives threads there with a
reason. `bb cow` lets you leave the same notes, under the same rules, so your
clean-up shows on their page with its "why".

Use these instead of `bb thread archive` when you clean up after a thread you
started: the reason is what the user reads later.

## A question for the user goes in `bb cow ask`

The user runs many threads. A question written at the end of a message
scrolls away and is not seen. Every question or decision you need from the
user goes in an ask, which stays on their page until they answer it. You may
also mention it in your message, but the ask is what they will see.

A reply reaches the user's queue only when it ends a turn the user started.
If you run a project, most of your turns are started by the threads under
you reporting back, or by bb's notices: your reply to such a turn will not
reach their queue, however it is worded. Anything that needs them goes
through `bb cow ask`.

```sh
bb cow ask --question "Ship the migration tonight or wait for the review?" \
  --option "tonight::unblocks the launch; no second pair of eyes" \
  --option "wait::safer; the launch slips a day" \
  --risk high --context "The migration rewrites 4M rows and cannot be rolled back."
```

- **One ask per decision.** Two decisions are two asks, each answered
  separately. Do not fold them into one question.
- **Give options when there are options** (up to 9), as `label` or
  `label::what choosing it means`. The user can still answer in words unless
  you add `--options-only`.
- `--risk low|medium|high` says how much rides on the answer. `--proof <path>`
  (repeatable) names a file under `$BB_THREAD_STORAGE` they should look at.
  `--context` is the background they need, up to 2000 characters.
- It prints the ask's id (`ask_…`). The answer arrives later as a message from
  the user that quotes your question. Carry on with work that does not depend
  on it, or say what you are waiting for and end your turn. Do not ask the
  same thing again, and do not assume an answer.
- **The user may answer in an ordinary message instead.** After the user
  messages you, run `bb cow asks --thread $BB_THREAD_ID`, and close every
  ask that message answered:
  `bb cow ask close <id> --answered "<their answer, quoted or closely paraphrased>"`.
  It leaves their queue at once and sends you nothing. Otherwise the ask
  stays in front of them, already answered.
- `bb cow ask withdraw <id>` is for a question that no longer needs an
  answer; it is not for one that was answered.
- **The user is shown both of these.** Withdrawing an ask, and closing one
  as answered when the user has not sent your thread a message since you
  asked, put a notice in their queue (with the question, and the answer you
  say they gave) until they acknowledge it, and in the log. Closing after
  they did write to you is the ordinary case and shows nothing extra. This
  is not a reason to avoid either when it is right: an ask that no longer
  needs an answer should be withdrawn, and one answered in chat closed.
  `bb cow asks --thread $BB_THREAD_ID` lists what you still have open.
- `--thread <id>` asks for a thread under yours. You cannot ask for any other
  thread, and you cannot answer an ask: only the user does.

## A finished job ends with `bb cow brief submit`

The user cannot verify a long report by reading it. End a finished job by
submitting a brief: your claims, each with its evidence. A separate checker
then audits every claim, and the user is shown what it disputes first. The
checker is not shown your summary or your labels. cow itself shows it the
task your thread was started with, and what your checkout changed (the
files and the diff, clipped); you do not supply either.

Write the JSON file, then:

```sh
bb cow brief submit "$BB_THREAD_STORAGE/brief.json"
```

```json
{
  "summary": "One paragraph: what was asked and what you did.",
  "claims": [
    {
      "text": "Login is limited to 5 attempts a minute per IP.",
      "label": "checked",
      "evidence": [
        { "description": "the rule as deployed", "text": "rate: 5/min key: ip path: /login" },
        { "description": "probe output, 8 requests", "path": "probe.txt" }
      ]
    },
    { "text": "No other rule changed.", "label": "inferred",
      "evidence": [{ "description": "diff of the ruleset", "path": "rules.diff" }] },
    { "text": "It holds under production load.", "label": "not-checked" }
  ],
  "judgementCalls": [{ "text": "Is 5 a minute too strict for the office NAT?", "askId": "ask_1a2b3c4d" }],
  "notDone": ["No load test was run."]
}
```

- **Claims** are the things you say are true about the result, one per claim,
  each small enough to be right or wrong. Up to 30.
- **Label each claim honestly.** `checked`: you observed it, and the attached
  evidence shows it. `inferred`: you reasoned to it from something else.
  `not-checked`: you did not verify it. Your label is shown to the user as
  what you say, never as verification, and a claim labelled `checked` that
  its evidence does not show comes back disputed. An honest `inferred` or
  `not-checked` is not held against you; an optimistic `checked` is.
- **Attach the evidence**, up to 6 pieces per claim: a verbatim excerpt
  (`text`) or a text file you saved under `$BB_THREAD_STORAGE` (`path`), each
  with a one-line `description`. Attach the lines that show the claim
  (command output, the diff, the log), not a whole file: the checker reads
  12,000 characters of each piece and 60,000 in all. Beside it the checker
  has only the task and the diff, and it runs nothing, so evidence that only
  you have seen (a test run, a page you opened) does not count unless you
  attach it.
- **Answer the task's "Done means".** When the message your thread was
  started with has a "Done means" section, the checker answers for each of
  its checks from the diff and your evidence. A check it cannot see met is a
  dispute, whatever your claims say: attach the evidence for each one.
- **Do not change what decides whether your checks pass** without saying
  so. A diff that modifies, deletes or renames a test that existed before,
  or touches the configuration of CI, a linter, a formatter, a type checker
  or a test runner, is disputed with no model, and the user is asked to look.
  Adding a new test is fine. When such a change is the job, make it a claim,
  or a judgement call.
- **Judgement calls** are decisions that are the user's. Raise each as an ask
  first and put its id in `askId`.
- **`notDone`** lists what you left undone or did not check. Say it here
  rather than leaving it out.
- A rejected file tells you which field is wrong and what it must be. Fix it
  and submit again. An evidence description may be up to 600 characters: use
  it to say how to read the excerpt, not to argue the claim.
- A check that failed says why and prints what the checker answered. A
  checker whose answer could not be read is run once more by itself. Submitting again later stores a new version.
- The checker runs on cow's checker settings, or when they are empty on the
  provider and model your thread runs on. When it could not run, the reason
  names the provider and what bb said; when another provider could get past
  it, the thread above you or the user can run it there: `bb cow brief check
  <thread> --provider <id> --model <id>`. The checker starts in an empty
  workspace of its own, so a brief can be checked after your thread is
  archived and its worktree removed. A check run again that fails keeps the
  check before it.
- `--wait` waits for the checker and prints the result. Read the disputes:
  fetch the evidence a "cannot tell" asks for, correct a claim that was
  wrong, and submit again. You cannot run the check on your own brief
  yourself (`bb cow brief check` is for the thread above you and the user).

`bb cow brief show <thread>` prints a thread's latest brief as the checker
left it: disputes (a changed test or configuration, then claims, then the
task's checks), then judgement calls, then the other claims and checks,
then what was left undone and what the checker was shown. Each claim gives
the checker's verdict first and the agent's label after. Use it on the threads you started before you tell the user their
work is done. "Check failed" or "not checked" means nothing in it is
verified.

## Commands

```sh
bb cow status [--main <thread>] [--json]
bb cow archive <thread> [--reason <text>] [--outcome done|partial|redone|dropped] [--label <label>]
bb cow outcome <thread> done|partial|redone|dropped [--label <label>]
bb cow label <thread> [<label>] [--clear]
bb cow ledger [--days 14] [--by model|dispatcher|label] [--json]
bb cow spend [--month YYYY-MM] [--main <thread>] [--json]
bb cow usage [--json]
bb cow park <thread> --reason <text> [--pickup <date|+3d|+2w|text>] [--stop]
bb cow resume <thread>
bb cow next <thread> "<text>" | --clear
bb cow wait <thread> --on "<who or what>" [--for "<what is needed>"] [--remind <date|+3d|+2w>] | --clear
bb cow project <thread> [--clear]
bb cow todo add <thread> "<title>"
bb cow todo done <thread> <n>
bb cow todo rm <thread> <n>
bb cow todo list <thread>
bb cow ask --question <text> [--option <label>[::<detail>]]... [--options-only] [--risk low|medium|high] [--proof <path>]... [--context <text>] [--thread <id>]
bb cow ask close <id> --answered <the user's answer>
bb cow ask withdraw <id>
bb cow asks [--thread <id>] [--all]
bb cow brief submit <file.json> [--thread <id>] [--wait]
bb cow brief show <thread> [--version <n>] [--wait]
bb cow brief check <thread> [--model <id>] [--provider <id>] [--runs <n>] [--wait]
bb cow caps [--thread <id>] [--all]
bb cow caps log [--limit <n>]
bb cow cap request --kind dir|command --rule <text> --why <text> [--thread <id>]
bb cow help
```

Every command takes `--json` and `--help`. A refused command exits non-zero
and says why; with `--json` the error is `{"ok": false, "error": {...}}`.

### `bb cow status`

One line per thread under Main: place in the user's queue (if any), state,
time in that state, title and id, what it is doing or waiting on, and what
moves it next. Then the Parked shelf; To settle, every finished thread
that is not archived, waiting for the user's decision (unread first, then
oldest first, with what archiving each would leave behind); Kept, threads
the user keeps around on purpose; what was archived in the last 2 days;
Automations, bb's automations with when each runs next, its last result and
its recent run threads; and Outside Main, the open threads with no parent
that are under no Main (one a plugin started is only counted). Kept threads
are the user's choice, made on the page: leave them be, and do not archive
or park one unless the user asks. Do not move a thread from Outside Main
under Main unless the user asks; the user does it on the page with `A`.
cow only shows automations: manage them with `bb automation`, and only
when the user asks.

- Main defaults to the one last chosen on cow's page for the project you are
  in. Pass `--main <thread>` (your own id is in `$BB_THREAD_ID`) when that is
  not the one you mean.
- A thread with an open ask reads `wants`, "asks you: …", and is under
  "Waiting on the user". So is a finished thread whose brief has disputes or
  judgement calls the user has not read ("brief: 2 disputed"). A thread's
  line also says what its latest brief came to, such as "brief disputed: 1
  contradicted" or "brief: the check failed".
- An ask of a thread under a parked or kept thread is under "Waiting on the
  user" too, ending "under parked “…”" or "under kept “…”".
- "Taken out of the user's queue by an agent, not yet acknowledged by the
  user" lists, when there are any, the parks, withdrawals and closes of
  threads under this Main that the user is being shown.
- States: `wants` (it asked the user something, or it finished with a reply
  addressed to the user that they have not seen: one that ends its newest
  turn, which the user started), `blocked` (bb refused it
  a command or file change without asking; only the user can unblock it,
  from cow's page), `running`, `stuck`, `parked`, `kept`, `failed`, `idle` (a
  project with nothing to say; its line ends `[project]`), `done` (finished:
  to settle, or archived). A reply to a turn the user did not start is not
  in the queue: a finished job's report is to settle, and an idle project's
  or Main's line, marked `[unread]` until the user has seen it.
- Output is bounded: at most 80 open threads, 30 parked, 40 to settle, 30
  kept, 20 archived, 40 outside Main and 20 queue entries; the rest are
  counted.

### `bb cow archive <thread> [--reason <text>]`

Archives the thread in bb, recording why. Refused while the thread has an
open ask: the user answers it, or the thread closes or withdraws it. Refused unless the thread is done,
idle or failed (or blocked on a permission with no turn running), and refused
while threads under it are still open: archive or park those first. bb
archives the threads under it along with it.

**When you start a worker, label it with the kind of job**: `bb cow label <thread> lookup` (or `draft`, `code-change`, …; one short lower-case word).
The ledger groups by label, then by model, so the user can see whether each kind of job is on the right model.

**When you archive a worker you dispatched, give its outcome, honestly**,
with `--outcome`:

| Outcome | Means |
| --- | --- |
| `done` | the work was used as it came back |
| `partial` | some of it was used, or it needed a second worker |
| `redone` | it was wrong, and you or another thread redid it |
| `dropped` | it was not used |

"done" means the work was used as it came back: not that the worker said it
finished. If you had to steer it, fix its work or send another worker, it is
`partial` or `redone`. The outcome goes in cow's ledger with the worker's
model and effort, its time to first report and how often it was steered,
which the user reads to choose models: a flattering outcome misleads them.
A worker is a thread that finished a turn and is not a project, Main or an
automation's run; for anything else `--outcome` is refused, and nothing is
archived. If the user has already judged the outcome, yours is refused (and
nothing is archived): archive without `--outcome`.

### `bb cow outcome <thread> <outcome>`

Sets or changes a worker's outcome, open or archived, under the same rule as
archive. Use it when you learn later that work you called `done` had to be
redone. Each change keeps who made it and when. An outcome the user set is
never overwritten by a thread: you are refused, and told so.

### `bb cow ledger [--days 14] [--json]`

The rows of the workers archived through cow in that many days, and a summary
by model and by dispatching thread: how many workers, how many of each
outcome and how many unsaid, the median time to first report, the median
steers before it, and how many the user judged, and its tokens, their
dollars at list price, and dollars per done (all its dollars over how many
came to done). A group of fewer than 5 is counted, not compared. The ledger
holds no titles, prompts or message text.

### `bb cow spend [--month YYYY-MM] [--json]`

This month's tokens and list-price dollars under Main, archived threads
included: workers, project threads, Main, cow's checker runs, the total,
and how many threads had no usage recorded. Use it when the user asks what
work is costing. Dollars are an estimate at the providers' list prices, not
a bill (on a subscription the user is not billed this); say so when you
quote them, and never quote a model with no list price as $0. bb keeps only
a thread's latest usage events, so a thread older than cow's first read of
it shows less than it used: say that too when you quote a long-lived thread.

### `bb cow usage [--json]`

What the usage line on cow's page shows: each usage window of every
signed-in provider (percent, and when it resets), this month's list-price
dollars of every thread on this bb, and with a monthly budget set, the
budget and the month-end figure at the current pace; then the usage notices
waiting for the user. Use it when the user asks how close they are to a
limit or a budget. cow tells the user itself, in their queue and by
notification, when a window or the budget passes its mark: you do not need
to watch it, and it is not a reason to stop, shorten or change work you were
asked to do. Only the user acknowledges a usage notice, on the page.

Caps per label and stuck checks (the same call again and again, a quiet or a
long-running turn) are shown to the user, as a mark on a worker's line and in `bb cow status`.
A worker is never stopped by cow: a mark is not an instruction to you or to it.

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

**Parking a thread that was waiting on the user is shown to them**: one
with an open ask, one of bb's own questions or permission requests, a
refused permission, a failure, a brief with disputes, or a reply addressed
to them not yet seen. A notice in their queue names your thread, the one
parked, your reason and when, until they acknowledge it; the log keeps it,
and `bb cow status` lists it. Parking one that waited on nothing shows
nothing extra. This is not a reason to avoid parking when it is right: give
a reason the user will understand. An open ask of a thread under a parked
or kept thread stays in the user's queue, saying what it is under.

### `bb cow resume <thread>`

Removes the park note. The thread goes back into the tree in whatever state
bb gives it; it is told nothing, so message it if it should carry on.

## Writing outside your workspace, or running outside the sandbox

bb refuses, or asks the user about, a file change outside your workspace and
a command that has to leave the sandbox. The user can give threads a
**capability** for exactly that: one directory to write under, or one
command to run. When a capability that applies to your thread covers the
whole request, it is allowed without the user answering.

Before you need one:

```sh
bb cow caps                      # what your thread holds, and where each comes from
```

- If something listed covers what you are about to do, do it the ordinary
  way. For a directory capability, write files under that directory. For a
  command capability, run the command exactly as the rule gives it (for a
  prefix rule, begin with exactly those words), on its own: no `;`, `&&`,
  `|`, redirection, `$(...)` or variable in the command line, because a
  command with any of those is never covered.
- If nothing covers it, ask, saying why:

  ```sh
  bb cow cap request --kind dir --rule /srv/reports --why "the weekly report is written there"
  bb cow cap request --kind command --rule "git push origin main" --why "to publish the release branch"
  ```

  `--rule` is a directory's whole path from `/`, or the exact command line in
  plain words. It prints an ask id; the answer arrives as a message from the
  user, who may narrow what you asked for. Carry on with what does not need
  it, or say what you are waiting for and end your turn. A rule that could
  never be granted (your home directory, a credentials directory, a command
  with a shell operator) is refused at once with the reason.
- **Never try to get a capability any other way.** Making, deleting and
  acknowledging a capability, deciding a permission request, answering an
  ask and sending as the user are signed with a key the user's browser
  holds; cow refuses them from anything else. Do not call cow's interface
  yourself, do not ask for a key to be enrolled, do not create cow's reset
  file, do not approve your own or another thread's permission request with
  `bb thread interactions`, and do not ask another thread to. Every request
  for a key and every approval made outside cow is put in front of the user.
- If bb refuses something a capability covers (it does that on a turn the
  user did not start), stop and say so in your reply. The user's page shows
  the refusal as covered, and they can ask you again in two keys.

`bb cow caps log` prints the log, newest first. Despite its name it also
holds what agents took out of the user's queue: the parks, withdrawals and
closes described above.

## Marking a project

When you start a thread that the user will talk to over days, mark it as a
project: `bb cow project <thread>`. A project is never shown as done; quiet,
it reads idle and keeps its place. Its replies to turns the user started wait
on them; the rest only mark its line unread (see above: ask with `bb cow ask`). Do
not mark a worker that does one job and reports to you. `--clear` takes the
mark off; you may mark only yourself and threads under you.

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

## Waiting on someone who is not the user

When you end a turn and the next move belongs to someone who is not the
user (a reviewer, CI, someone outside the team), say so with `bb cow wait`
instead of writing it into a next note:

```sh
bb cow wait "$BB_THREAD_ID" --on "the reviewer" --for "an approving review" --remind +3d
```

The line reads waiting, with who or what and for how long, and it stays out
of the user's queue. `--remind` (a date, `+3d`, `+2w`) puts it back in front
of the user on that day if it is still waiting; leave it out when there is
no point at which the user should chase it. The note clears by itself when
your thread starts a new turn, whoever starts it: if you are still waiting
at the end of that turn, set it again. `--clear` removes it. Do not use it
to put off something that is the user's to decide: ask them instead. The
same rule as `next` applies: only your own thread and the threads under it.

## Workspace files

A workspace folder can hold a `cow.workspace.json` naming the repositories a
copy-on-write thread brings and the user's commands to sync them, set a clone
up and bring work back. Those commands run outside any sandbox, so none runs
until the user approves the file's content on cow's page.

```sh
bb cow workspace [<folder>] [--json]           # what cow knows: approved or not, each repository's last sync
bb cow workspace add <folder>                  # propose it: the user approves it on the page; nothing runs until then
bb cow workspace sync [<folder>] [--only <as>] # run the approved sync commands; dirty repositories are skipped
bb cow workspace back <thread> [--json]        # show what bringing its work back would run; runs nothing
```

Editing the file changes nothing that runs until the user approves the change.
Bringing a thread's work back is the user's alone: they do it with `B` on the
thread's line on cow's page, and nothing else runs it. When a thread's work is
ready to come back, do not try to run anything: say so with `bb cow ask`,
naming the thread (for example `bb cow ask "@thread:<id> is ready to bring
back: 2 commits in api" --thread <id>`), and the user decides. You cannot read
a command's output; the user sees it on the page.

## Limits

- Only the user can answer a question or an ask, grant a permission, deal
  with a refused permission, make, delete or acknowledge a capability, or
  mark a reply or a brief as seen, or dismiss a refused permission; those
  are done on cow's page and signed there with a key only their browser
  has, and cow refuses them from anything else.
- Parking or archiving a thread takes it out of the user's queue. Do it only
  for a thread whose work is yours to set aside, give the real reason, and
  never to put away something that is waiting for the user to see: a reply
  to them, a failure, a refused permission, a brief with disputes.
- There is no undo from the CLI. `bb cow resume` reverses a park;
  `bb thread unarchive <thread>` reverses an archive (the reason is kept).
