# 🐄 cow

cow is a plugin for [bb](https://getbb.app). You run your work through one
long-lived **Main** thread that hands jobs to other threads, and cow gives you
one page that shows every one of them: what state it is in, for how long, what
it is doing, and what moves it next. The page is driven from the keyboard, in
the manner of vim.

## Status

Early. The page is read-only apart from talking to threads: it shows states,
opens chats and sends messages. It cannot park, stop or answer from the page
yet, and the states come only from what bb already knows about a thread.

One thing to know: opening a thread's chat from cow marks that thread read.
That is how a finished thread stops asking for you.

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

The page starts in normal mode. Typing in any input works as usual.

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
| `Tab`, `Shift+Tab` | next, previous line that is waiting on you |
| `1` to `9` | jump to that place in the queue |
| `M` | choose a different Main |
| `?` | the legend and this key map |

While the cursor is in the overview, no key reaches the embedded chat, so a
stray digit cannot answer a question there. Keys with Cmd, Ctrl or Alt are
left to bb. "🐄 cow: choose the Main thread" is also in bb's command palette
while the page is open.

## States

| Mark | State | Means |
| --- | --- | --- |
| ● | wants you | it asked something, or finished with a reply you have not read |
| ▶ | running | a turn is in progress |
| ◆ | stuck | running with no event for 2 hours, or waiting on you for 7 days |
| ✕ | failed | its last turn ended in an error |
| ✓ | done | finished and read, or archived, in the last 2 days; older ones are only counted |

The limits live in one place, `LIMITS` in `src/state.ts`.

## Develop

```sh
npm test            # unit tests: states, tree, hints, parsing
npm run typecheck
```

`npm run e2e` drives the real page in a separate headless Chrome. It creates
four cheap fixture threads titled "cow test", writes only to those, and
archives them afterwards. See the top of `scripts/e2e.mjs` for how to run it.

## Turn it off

```sh
bb plugin disable cow   # unload it; your choice of Main is kept
bb plugin remove cow    # uninstall it and delete what it stored
```

cow stores one thing: which thread is Main for each project.

## License

MIT
