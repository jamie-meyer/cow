---
name: cow
description: Ask the user a question so it stays in front of them (`bb cow ask`), report a finished job as a brief an independent checker audits (`bb cow brief submit`), see or ask for a capability to write outside your workspace or run a command outside the sandbox (`bb cow caps`, `bb cow cap request`), record why a thread is parked or archived, say what is next for your thread or who other than the user it waits on (`bb cow wait`), and read the overview of every thread under Main. Use whenever you have a question or decision for the user, when you finish a job, when you need to write outside your workspace or run something bb's sandbox refuses, when cleaning up or setting aside threads you started, when you end a turn with work still planned or waiting on a reviewer, CI or someone else, or when asked what is waiting on the user.
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
  `bb cow asks --thread $BB_THREAD_ID` lists what you still have open.
- `--thread <id>` asks for a thread under yours. You cannot ask for any other
  thread, and you cannot answer an ask: only the user does.

## A finished job ends with `bb cow brief submit`

The user cannot verify a long report by reading it. End a finished job by
submitting a brief: your claims, each with its evidence. A separate checker
that sees only the brief then audits every claim, and the user is shown what
it disputes first.

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
  12,000 characters of each piece and 60,000 in all. The checker has nothing
  but this, so evidence that only you have seen does not count.
- **Judgement calls** are decisions that are the user's. Raise each as an ask
  first and put its id in `askId`.
- **`notDone`** lists what you left undone or did not check. Say it here
  rather than leaving it out.
- A rejected file tells you which field is wrong and what it must be. Fix it
  and submit again. An evidence description may be up to 600 characters: use
  it to say how to read the excerpt, not to argue the claim.
- A check that failed says why and prints what the checker answered. A
  checker whose answer could not be read is run once more by itself. Submitting again later stores a new version.
- `--wait` waits for the checker and prints the result. Read the disputes:
  fetch the evidence a "cannot tell" asks for, correct a claim that was
  wrong, and submit again. You cannot run the check on your own brief
  yourself (`bb cow brief check` is for the thread above you and the user).

`bb cow brief show <thread>` prints a thread's latest brief as the checker
left it: disputes, then judgement calls, then the other claims, then what was
left undone. Use it on the threads you started before you tell the user their
work is done. "Check failed" or "not checked" means nothing in it is
verified.

## Commands

```sh
bb cow status [--main <thread>] [--json]
bb cow archive <thread> [--reason <text>]
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
the user keeps around on purpose; and what was archived in the last 2 days.
Kept threads are the user's choice, made on the page: leave them be, and do
not archive or park one unless the user asks.

- Main defaults to the one last chosen on cow's page for the project you are
  in. Pass `--main <thread>` (your own id is in `$BB_THREAD_ID`) when that is
  not the one you mean.
- A thread with an open ask reads `wants`, "asks you: …", and is under
  "Waiting on the user". So is a finished thread whose brief has disputes or
  judgement calls the user has not read ("brief: 2 disputed"). A thread's
  line also says what its latest brief came to, such as "brief disputed: 1
  contradicted" or "brief: the check failed".
- States: `wants` (it asked the user something, or it finished with a reply
  addressed to the user that they have not seen: a thread with threads
  under it, or one whose newest turn the user started), `blocked` (bb refused it
  a command or file change without asking; only the user can unblock it,
  from cow's page), `running`, `stuck`, `parked`, `kept`, `failed`, `idle` (a
  project with nothing to say; its line ends `[project]`), `done` (finished:
  to settle, or archived). A finished job's report is not in the queue; it
  is to settle, marked `[unread]` until the user has seen it.
- Output is bounded: at most 80 open threads, 30 parked, 40 to settle, 30
  kept, 20 archived and 20 queue entries; the rest are counted.

### `bb cow archive <thread> [--reason <text>]`

Archives the thread in bb, recording why. Refused while the thread has an
open ask: the user answers it, or the thread closes or withdraws it. Refused unless the thread is done,
idle or failed (or blocked on a permission with no turn running), and refused
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

`bb cow caps log` prints the log, newest first.

## Marking a project

When you start a thread that the user will talk to over days, mark it as a
project: `bb cow project <thread>`. A project is never shown as done; quiet,
it reads idle and keeps its place, and its replies are the user's to read. Do
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
