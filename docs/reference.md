# cow: reference

The [README](../README.md) says what cow is, how to install it and what it
stores and sends. This is the detail behind each idea: every rule the page
and the `bb cow` commands follow. Sections refer to each other by name.

Contents: [States](#states) · [Groups](#groups) · [Projects](#projects) · [Replies addressed to you](#replies-addressed-to-you) · [What is next](#what-is-next) · [Filtering](#filtering) · [Scrolling the chat](#scrolling-the-chat) · [The reader](#the-reader) · [Answering](#answering) · [Permission requests](#permission-requests) · [Blocked on a permission](#blocked-on-a-permission) · [Asks](#asks) · [Briefs and the checker](#briefs-and-the-checker) · [Parking](#parking) · [Archiving, with a reason](#archiving-with-a-reason) · [Undo](#undo) · [Capabilities](#capabilities) · [The CLI, for agents](#the-cli-for-agents) · [Theme](#theme)

## States

| Mark | State | Means |
| --- | --- | --- |
| ● | wants you | it has an ask open for you, it asked a question or for permission, one of its permission requests was decided outside cow, its brief has disputes or judgement calls you have not read, or it finished with a reply addressed to you that you have not seen |
| ⊘ | blocked on a permission | bb refused it a command or a file change without asking you; `a` asks again as you |
| ▶ | running | a turn is in progress |
| ◆ | stuck | running with no event for 2 hours, or waiting on you for 7 days |
| ‖ | parked | you set it aside with `p`; it is on the shelf until it comes back |
| ✕ | failed | its last turn ended in an error; stays in the queue |
| ○ | idle | a project with nothing to say: quiet, in its place, never done; see "Projects" |
| ✓ | done | finished, or archived, in the last 2 days; older ones are only counted. A project is done only when archived |
| ◌ | not started | not a thread: work a thread has listed for later |

Two more marks sit beside a title, and say nothing about the thread's state:

| Mark | Means |
| --- | --- |
| ▤ and ✓, ▶ or ✕ | the thread submitted a brief, and a checker disputed none of its claims (✓), is auditing it now (▶), or failed to give a usable answer (✕: nothing in it is verified) |
| ▤ ≠ 2 | the checker disputes that many of the brief's claims |
| a key, and 3× | the thread holds a capability; capabilities have allowed that many of its requests. "new" beside it: one you have not acknowledged |

When several things wait on you at once, a line shows the first of: a
failure; a question or permission request raised in its chat, which holds a
running turn; an open ask; a request of its own that was decided outside cow;
a permission bb refused; a brief with disputes or judgement calls; a reply
addressed to you. The others are still there when
that one is dealt with.

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
- A line directly under Main that is finished goes to Done. A group's head
  is a project, so it is not finished until you archive it: then the group
  goes to Done as one line that says how many threads are under it.
- An archived line always leaves its place: archiving is you putting it
  away. It is listed under Done with its reason, as before.
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

A project that is not archived is never done, and never moves to the Done
section. When it has nothing to say (no turn running, nothing waiting on
you, no reply you have not seen) it is **idle**: a state of its own, with
its own mark (○), that shows how long it has been quiet and, in the next
column, what it says is next. It stays in its place in the tree.

Everything else happens to a project as to any thread. Its finished turn is
a reply addressed to you until you have seen it, whoever started the turn. It
can ask, be parked (it goes to the shelf), run, and read as stuck or failed.
Archiving it with `e` is you saying it is finished: it leaves the tree and
is listed under Done with its reason.

A project with nothing under it carries a small square (▫) before its name,
so it can be told from a worker at a glance; a group's head has its fold
mark instead. The mark is one of cow's notes on the thread.

## Replies addressed to you

bb tracks unread replies only for threads without a parent, such as Main.
Under cow you also talk to threads that have one: a project thread that
Main started, say. So cow works out for itself whose a finished turn's
reply is. It is addressed to you when:

- the thread is a project (a group head, or marked as one), whoever started
  the turn. bb's own notice
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
thread, in the plugin's own storage and not on the thread. Setting that
record, and taking it back, is a signed call: see "Only you: signed calls".
It is set when you:

- open the thread's chat from the page (`Enter`), or have it open when the
  reply arrives;
- send it a message from the page (`I`, or `i` for a Main that has a
  parent);
- press `Space` on its line. `u` takes that one back.

A message you send the thread later, from anywhere in bb, also clears it:
you evidently read it. A reply that comes after the one you saw waits on
you again. On a page whose key is not enrolled none of these marks anything:
`Space` says "not marked as seen: this page's key … is not enrolled", and
opening the chat says the reply still waits on you, and why.

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
in the chat, as it did. If bb opens a file tab on cow's page some other way,
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
  and "(and 2 more)" when it has several. It is in the queue, on the page and
  in `bb cow status`, whatever else it is doing: still running, finished, or
  parked. Only an archived thread's asks are left out.
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
is one message: the brief and its evidence. It has no parent, so it shares no
conversation with the thread that did the work and wakes nobody; it is hidden
from the thread list, and its thread is stopped and archived when it
answers. For each claim it states in one sentence what the evidence
literally shows, then gives a verdict: `supported`, `not-supported`, or
`cannot-tell` with the evidence that would settle it.

- It is told to use no tool, and bb gives a plugin no way to start a thread
  without tools. So cow reads the checker's own timeline afterwards, and an
  answer from a checker that used any tool is thrown away.
- Its answer must be one JSON object with a verdict for every claim. Anything
  else (prose, a missing claim, a `cannot-tell` that does not say what would
  settle it, an error, no answer in ten minutes) is a **failed check**, shown
  as one. It is never a pass.
- An answer that cannot be read (broken JSON, a claim left out) is tried once
  more with a fresh checker before the check fails: a slip in the form is not
  a verdict on the brief. A checker that used a tool, errored or said nothing
  is not tried again.
- A failed check keeps the reason and what the checker answered, as it came.
  The sheet and `bb cow brief show` print both, so that you can see whether
  it was the checker or the brief that went wrong. None of it counts as a
  verdict.
- The thread a brief is from cannot order its own audit. The thread above it
  can, and so can you. That rule goes by the name the caller gives, which is
  the caller's own word, so cow does not rest on it: see the next point.
- Running a check again takes nothing out of your queue. If the check it
  replaces disputed claims and you had not opened the brief, the brief keeps
  waiting whatever the new check says (failed, or clean), and says "N
  disputed by an earlier check that was run again unread"; the sheet and
  `bb cow brief show` say the same above the new check's result. A
  judgement call keeps waiting while the new check runs. Only you opening
  the brief ends the wait.

A claim is **disputed** when the checker's verdict is weaker than the agent's
label warrants:

| The agent says | Checker: not supported | Checker: cannot tell |
| --- | --- | --- |
| `checked` | contradicted | not established |
| `inferred` | contradicted | agreement, no dispute |
| `not-checked` | agreement, no dispute | agreement, no dispute |

### Reading a brief on the page

A line whose thread has submitted a brief carries its mark (see "States").
A finished thread whose brief has disputes, or lists judgement calls, wants
you and is in the queue ("brief: 2 disputed, 1 judgement call") until you
have opened it. A brief the checker did not dispute, and that leaves you no
decision, puts nothing in the queue.

`b` opens the brief as a sheet over the whole page:

1. what the check was: how many runs, of which model, or that it failed and
   why, or that none has run;
2. the disputed claims, contradicted ones first. Each shows the claim, the
   agent's own label as the agent's words, what the evidence literally
   shows, and the checker's verdict. "Contradicted" is filled in red; "not
   established" is outlined, and says what evidence would settle it;
3. the judgement calls. One that was raised as an ask and is still open is
   answered in place with `a`;
4. the other claims. One the checker supported says "found it supported" and
   nothing more;
5. what the agent lists as left undone, then its summary.

| Key in the sheet | Does |
| --- | --- |
| `j` `k`, `g g`, `G` | move between claims and judgement calls |
| `l`, `Enter` | open the claim's evidence in place: excerpts as text, and a file as the text that was submitted, with a link that opens the file as it is now in the reader; `q` there returns to the brief |
| `h` | close it |
| `a` | answer the judgement call under the cursor, when it is open as an ask |
| `c` | run the check again, after `y`: it costs a model run for each run in the settings and replaces the verdicts |
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
the agent chose to attach, done without the agent's conversation. "Supported"
means that reader found the evidence shows the claim. It does not mean the
claim was verified against the world, and the checker cannot see what was
left out of the evidence. A failed check, or none, means nothing in the
brief has been looked at by anyone but its author; the page says so and
never shows it as clean.

`bb cow brief show` prints the disputes first (the claim, what the agent
says, what the evidence literally shows, the verdict), contradicted before
not established; then the judgement calls; then the other claims; then what
was left undone. The agent's label is always printed as "the agent says",
never as verification. `bb cow status` adds to a thread's line what its
latest brief came to, such as "brief disputed: 1 contradicted".

Settings (Settings → Installed plugins → cow, or `bb plugin config cow`):

| Setting | Default | Means |
| --- | --- | --- |
| `checkerModel`, `checkerProvider` | empty | the checker's model and provider; empty is bb's default for the project |
| `checkerRuns` | 1 | independent checkers per brief, up to 5. The weakest verdict stands, and a claim the runs disagree on says so |
| `checkOnSubmit` | on | check a brief as soon as it is submitted |

A small model is cheaper, and its "not supported" is worth having, but its
"supported" is weaker than a large model's; more than one run shows where it
wavers. The checker catches what the evidence contradicts or fails to
establish. It cannot catch what the agent left out of the evidence.

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

Parking takes what the line was waiting on you for out of the queue: a
reply, a failure, a refusal, a brief. Its own open ask stays in the queue;
an ask of a thread under it does not. An agent can park a thread too
(`bb cow park`), and parking is not signed, so the shelf is where to look
for work an agent set aside: see "What is not signed, method by method".

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
Done ("archived: …"), where an archived line is listed for two days and
counted after that. An archived thread waits on you for nothing, an open ask
included. An agent can archive a thread too, with `bb cow archive` or with
bb's own `bb thread archive`; neither is signed. If you undo the archive the note stays on the thread,
so archiving it again offers the same reason; clear the line to archive
without one.

## Undo

`u` takes back the last park, resume, archive (it unarchives), dismissal of
a refused permission, or mark as seen made with `Space`, then the one
before, for as long as the page stays open. Taking back a dismissal or a
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
bb cow caps log [--limit <n>] [--json]           # the log, newest first
bb cow cap request --kind dir|command --rule <text> --why <text> [--thread <id>]
```

`cap request` raises an ask on the page ("asks for a capability: write under
/srv/reports") with two answers, grant it and refuse. Granting opens the same
steps, starting from what was asked for, which you can narrow or widen; when
you save, the thread is told what was granted. A rule that could never be
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
  acknowledged, every request allowed through a capability (when, on which
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
  thread is a project's Main, which is where a new window starts; and
  approving, refusing or removing a key. Opening a chat or a brief on the
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
it. Nothing here is written to the log, apart from `cap request`. And the
CLI's rules about whose thread a command may touch go by the thread the
caller names in `BB_THREAD_ID`, which bb sets for a thread and the thread
can change or clear: a caller that names nobody is taken for you at a
terminal and may touch any thread, so those rules guide a well-behaved
agent and stop no other.

**Methods of the interface** (what the page calls)

| Method | What it does | Meant for an agent? | What an agent calling it could hide from you or change |
| --- | --- | --- | --- |
| `main_state`, `notes_list`, `asks_list`, `brief_get`, `brief_marks`, `caps_state`, `caps_log`, `keys_state` | read: the recorded Mains, cow's notes on threads (parks, archive reasons, dismissals, what is next, work not started, replies seen, project marks), asks, briefs, capabilities, the log, the keys | yes: `bb cow status`, `asks`, `brief show`, `caps` read the same | nothing. They change nothing |
| `signed` | carries out one of your actions when the call is signed by an enrolled key | no | nothing without a signature: an unsigned or forged call is refused and changes nothing |
| `key_enrol` | presents a key. With none enrolled it is enrolled; otherwise it becomes a request | no, but any caller can | on a cow with no key enrolled, it becomes the enrolled key, and your page then says in red that it is not: see "If something else enrolled first". Otherwise it adds a request to your queue under a name of its choosing, at most 8 at a time, and can do nothing until you approve it |
| `park_set` | writes or removes a thread's park note, with none of the CLI's checks | the page's `p` and `r`; an agent uses `bb cow park` and `resume` | **parking takes a line out of your queue.** The thread leaves the tree with every thread under it. What it waited on you for (a reply, a failure, a refusal, a brief, a decision made outside cow) stops waiting, and so does everything that threads under it waited on you for, their open asks included. Still visible: the line is on the Parked shelf with the reason given, how long, and how many threads went with it; its own open ask stays in the queue; and it returns to the queue on its pick-up date, or every four weeks without one. A caller can set that date far ahead, and can change the reason or the date of a park you made. Removing a note only puts a line back |
| `thread_archive` | archives a thread in bb with a reason, and stops its turn first when asked to | the page's `e` and `x`; an agent uses `bb cow archive`, or bb's own `bb thread archive` | **archiving takes a line out of your queue**, with whatever it waited on you for, an open ask included, and bb archives the threads under it too. Still visible: the line is listed under Done with its reason for two days, and counted there after that. cow could not stop this by signing it: `bb thread archive` is bb's and does the same |
| `archive_note_set` | sets or forgets the reason kept for an archived thread | the page, when an archive is undone or redone | the reason shown under Done can be changed or removed. It archives nothing and moves nothing |
| `project_set` | marks a thread as a project, or takes the mark off | the page's `P`; an agent uses `bb cow project` | taking the mark off a thread with no threads under it changes whose its replies are: one that ended a turn you did not start stops reading "replied to you" and leaves the queue, and the line reads done, under Done, instead of idle in the tree. Marking only adds to what waits on you |
| `todo_change` | removes an item from a thread's list of work not started, or moves it | the page's `x`, `J` and `K`; an agent uses `bb cow todo` | a not-started row can be removed from the tree or reordered. Those rows are never in the queue |
| `brief_check` | starts a new check of a thread's latest brief, with the model, provider and number of runs the caller names | the page's `c` in a brief; an agent above the thread uses `bb cow brief check` | it costs a model run each time, and replaces the verdicts the brief shows with the new check's, which a caller can make fail by naming a model that does not exist. **It cannot take the brief out of your queue**: a dispute you have not read keeps the brief waiting through the new check and whatever it says, and so does a judgement call. On a brief you had read it does the opposite and makes it wait again |

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
| `ask withdraw <id>` | takes an open ask out of your queue, unanswered | **the ask leaves your queue**, and nothing on the page says it was there; `bb cow asks --all` still lists it as withdrawn. Meant for the thread that asked and the threads above it; a caller that names nobody can withdraw any ask |
| `ask close <id> --answered <text>` | closes an ask as answered in chat, recording the answer the caller says it was given | the same, with the caller's account of your answer kept on the ask. Closing one from the page as you is the signed `ask_close` |
| `brief submit` | stores a new version of a thread's brief and has it checked | the new version replaces the one that waited. If its check disputes nothing and it lists no judgement call, nothing waits, and the disputes of the version before are no longer in front of you; every version is kept and `bb cow brief show <thread> --version <n>` prints it |
| `brief check` | as `brief_check` above; refused to the thread the brief is from when it names itself | as `brief_check`: it costs a run and cannot take a waiting brief out of your queue |
| `cap request` | raises an ask for a capability and writes "requested" in the log | adds to your queue and grants nothing |
| `next`, `todo add`, `todo done`, `todo rm` | the thread's own line of what is next, and its list of work not started | the next-move column of a line that waits on nothing shows the agent's words, marked as its own. A line with a note or a list stays in the tree instead of going to Done. Nothing leaves the queue |
| `project`, `project --clear` | as `project_set` above | as `project_set` |
| `park`, `resume` | as `park_set`, under the page's rules: not Main, not an archived thread, not one already parked unless it has come back; a running turn only with `--stop` | as `park_set`. An agent can park any thread it can name, itself included, and "keep parked" one that had come back to your queue, with a new date |
| `archive` | as `thread_archive`, under the page's rules: only a done, idle or failed line, one blocked with its turn over, or one waiting only for its brief to be read; never one with an open ask or with open threads under it | a failure, a refusal or an unread brief leaves your queue with the line. Still visible under Done, with its reason, for two days |

What follows from this: **the queue is everything cow knows waits on you,
minus what has been parked or archived.** Nothing else of cow's that is
unsigned takes an entry out of it, apart from a thread withdrawing or
closing an ask, replacing its brief with a new version, or taking a project
mark off. What bb's own commands can do to it is under "What cow cannot
guarantee". So the Parked shelf and Done are the two places to look
for something an agent set aside, and each line there says why it is there.

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
- **Still only visible: parking and archiving.** An agent can park or
  archive a thread, and that takes its line out of your queue. The line is
  on the Parked shelf or under Done afterwards, with the reason given. See
  the table above.
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
  thread says you have messaged since. For a Main with no parent, cow goes
  by bb's own record of what you have read, which bb's own commands set (`bb thread read`).
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
bb cow archive <thread> [--reason <text>]
bb cow park <thread> --reason <text> [--pickup <date|+3d|+2w|text>] [--stop]
bb cow resume <thread>
bb cow next <thread> "<text>" | --clear
bb cow project <thread> [--clear]
bb cow todo add <thread> "<title>"
bb cow todo done <thread> <n>
bb cow todo rm <thread> <n>
bb cow todo list <thread>
bb cow help
```

| Command | Does |
| --- | --- |
| `status` | the overview as text: the queue, then one line per thread with its state, time in state, and what it is doing or waiting on, then the parked shelf and what finished in the last 2 days. A thread that holds capabilities ends `[holds: …]` with their names, and one whose permission request was decided outside cow reads "approved outside cow: …" and is in the queue |
| `archive` | archives a done or failed thread in bb and records the reason; refused while threads under it are still open |
| `park` | sets a thread aside; the reason is required, and `--pickup` is read exactly as the page reads a pick-up |
| `resume` | takes a parked thread off the shelf |
| `next` | sets, or with `--clear` removes, the one line that says what happens next for a thread |
| `project` | marks a thread as a project, or with `--clear` takes the mark off: it then reads idle, never done, until it is archived |
| `todo add` | adds a piece of work not started to the end of a thread's list; the list holds 12 |
| `todo done`, `todo rm` | take item `n` off the list: its work has started, or it will not be done |
| `todo list` | the list, numbered from 1 |

`status` uses the Main last chosen on the page for the project the command
runs in, unless `--main` names one. Its output is bounded: at most 80 open
threads, 30 parked, 20 done and 20 queue entries are listed, and the rest are
counted. `park` refuses a thread whose turn is running unless `--stop` is
given, which stops the turn first, as the page does after asking. A refused
command exits non-zero and says why; every command takes `--json`.

`next`, `todo` and `project` may be run by a thread only on itself and on the threads
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
