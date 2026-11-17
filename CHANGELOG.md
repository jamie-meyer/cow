# Changelog

What changed for someone who uses cow. Versions are tags in this repository:
`v0.2.1` is the commit `bb plugin install` gives you for a range that allows
0.2.1.

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
