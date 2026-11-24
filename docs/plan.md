# Spokeline: plan

Date: 18 November 2026. Status: draft for review.

**In one line:** Spokeline lets you talk to Claude Code and hear short spoken answers back, hands-free,
wherever Claude Code runs: the terminal, the VS Code panel and the Claude desktop app.

---

## 1. Decisions already made

| # | Decision | Why |
|---|---|---|
| D1 | **Spokeline is a Claude Code plugin**, not a VS Code extension | The plugin's code runs inside Claude itself, so the same code works in the terminal, the VS Code panel and the desktop app |
| D2 | **The microphone part is a small helper program shipped inside the plugin**, started by the plugin | One install for the user. Recording sound needs native code in every design, so we can't avoid it; we keep it in one small place |
| D3 | **No servers, nothing listening on the network** | Safety. The parts talk through small files in the user's own folder |
| D4 | **Speech is turned into text on the user's computer** | Privacy, no API keys, no cost per minute |
| D5 | **Remote work over SSH is out of scope** | Product decision, 18 November 2026 |
| D6 | **"Claude" is not in the product name** | Anthropic's rule for third-party products |
| D7 | **A VS Code extension is optional and comes last** | Only for things only VS Code can do (shortcut keys anywhere in VS Code, status-bar icon, chat-manager features) |

---

## 2. How it works

### 2.1 The parts

```
                    one per computer                      one per open Claude chat
 ┌───────────────────────────────────────┐        ┌──────────────────────────────────────┐
 │ "Ears" helper (native program)        │        │ Spokeline mod (inside Claude)         │
 │  • listens to the microphone          │ words  │  • picks up your words, sends them    │
 │  • notices when you start/stop talking│ ─────> │    as your own message                │
 │  • wake word (later)                  │ (file) │  • "stop" → stops Claude              │
 │  • turns speech into text, on device  │        │  • takes Claude's final answer,       │
 │  • decides which chat you talk to     │ <───── │    makes it short, speaks it          │
 │                                       │ status │  • says "needs permission", "done"    │
 │                                       │ (file) │  • shows mic status inside the panel  │
 └───────────────────────────────────────┘        └──────────────────────────────────────┘
```

**The mod** is the plugin code that Claude Code runs inside its own process ("mods" are Anthropic's
official add-on system). It uses these documented calls:

| What it does | Official call |
|---|---|
| Send your words as your own message (waits until Claude is idle) | `$.prompt.submit({ text, asUser: true })` |
| Put text in the input box without sending (for "check before send" mode) | `$.prompt.fill({ text })` |
| Stop Claude's current answer | `$.turn.abort({ turnId })` |
| Get Claude's final answer when a turn ends | the `turn.complete` event, field `e.answer` |
| Know when a turn starts (needed to stop it) | the `turn.start` event |
| Shorten the answer for speaking | `$.model.complete` with a small, fast model, on the user's own plan |
| Speak | `$.audio.speak(text)` (uses the computer's built-in voice, `say` on Mac) |
| Notice permission requests | the `tool.check` event |
| Show status inside the panel | `$.ui.status`, `$.ui.toast`, or a small band above the input box |
| Start the Ears helper | `$.process.spawn` |
| Read and write the shared files | `$.fs.read`, `$.fs.write`, `$.fs.stat` |
| Check the files several times a second | `$.clock.every` |

**The Ears helper** is a small native program. A mod cannot record sound, and neither can any web-based
part of VS Code, so this piece has to be native code.

### 2.2 How the two parts talk (no server)

All files live in `~/.spokeline/`, readable only by the user (file mode 0600).

| File | Written by | Read by | Contents |
|---|---|---|---|
| `sessions/<chat id>.json` | each mod | Ears | "I'm alive", chat title, folder, last time you used it, is Claude busy |
| `inbox/<chat id>.jsonl` | Ears | that chat's mod | each thing you said, one line each, with an id so nothing is sent twice |
| `live/<chat id>.json` | Ears | nobody yet (for showing your words while you speak) | the unfinished text of what you are saying now, `{ "text", "ts" }`; rewritten several times a second while it changes, at least once a second while you speak; empty text when you are not speaking |
| `state.json` | mods | Ears | "speaking now", so Ears pauses the mic and doesn't hear Claude's own voice |
| `ears.lock` | Ears | mods | which Ears process is running, so only one ever listens |

**Which chat gets your words:**
1. Whatever chat you named last ("switch to the login chat").
2. Otherwise, the chat you used most recently.

There's no official signal for "the chat window in front", so we don't depend on one.

### 2.3 One round trip

1. You hold the push-to-talk key, or later say the wake word, and speak.
2. Ears notices the end of your sentence, turns it into text, and writes it to the right chat's inbox.
3. That chat's mod sees the new line within a quarter of a second and sends it as your message.
4. Claude works as usual. Permission boxes still appear as normal.
5. The turn ends. The mod takes only the final answer and shortens it to 1–3 sentences, with no code,
   file paths, tables or links.
6. The mod marks "speaking" in `state.json` so Ears pauses the mic, speaks the answer, then clears the mark.

### 2.4 "Without the noise": what gets spoken

| Moment | Spoken? | Example |
|---|---|---|
| Claude finishes | Yes, short summary | "Fixed the login bug in two files. Tests pass." |
| Claude needs permission | Yes | "Claude wants to run the tests. Approve?" |
| Claude asks a question | Yes, the question | "Which database should I use: Postgres or SQLite?" |
| Error | Yes | "The request failed: rate limit." |
| Tool steps while working | No | — |
| Code, file lists, tables, links | Never read out | — |

Two summary modes, chosen in the settings:
- **Smart (default):** a small model rewrites the answer for speaking. It costs a little usage on the user's
  own Claude plan.
- **Simple:** no model call; we just strip code blocks, paths, tables and links, and read the first sentences.

---

## 3. Unknowns to test first

These decide whether the design holds. Phase 1 exists to answer them.

| # | Question | If the answer is no |
|---|---|---|
| U1 | Does `$.audio.speak` work when the chat is in the VS Code panel (not only in the terminal)? | Ears also does the speaking |
| U2 | Does `$.prompt.submit({ asUser: true })` appear in the VS Code panel as your own message and start a turn? | Blocker: report to Anthropic and look for another route |
| U3 | After the mod stops a turn with `$.turn.abort`, does the next spoken prompt go through? The docs say only a *person's* stop blocks later calls | Voice "stop" turns into "stop, then you type once" |
| U4 | Does a helper started with `$.process.spawn` keep running? Does it stop when its chat closes? | Ears runs as a separate background helper that shuts itself down when no chats are left |
| U5 | Is checking the inbox 4 times a second cheap and fast enough? | Check less often, or let Ears push through the spawn output stream |
| U6 | Does the status band show inside the VS Code panel? (needs extension 2.1.299+; we have 2.1.326) | Use `$.ui.status` only |
| U7 | Does the built-in safety guard load for our account? It loads for Team/Enterprise logins or managed settings | If it loads, voice can say "no" to actions but not "yes" to ones the rules say must be asked; you click those |
| U8 | How does the Mac microphone permission prompt behave when the helper is started from Terminal, VS Code or the desktop app? | Document it; one prompt per app is acceptable |

---

## 4. Phases

Each phase ends with something you can try yourself.

### Phase 0: set-up (½ day)
- Repo layout (section 6), the repo acting as its own plugin marketplace.
- Development loop: run `claude --plugin-dir ./plugins/spokeline`, edit, `/reload-plugins`.
- `claude plugin validate` passes.

**Done when:** an empty mod loads and shows "Spokeline loaded" in the terminal and in the VS Code panel.

### Phase 1: test mod, no microphone (1–2 days)
- When a turn ends, speak the first sentence of the answer.
- A `/spokeline say <text>` command that sends text as your message (simulates speech).
- A `/spokeline stop` command that stops the current turn.
- Answer U1, U2, U3, U6 and U7, and write the answers down in `docs/findings.md`.

**Done when:** in the VS Code panel, typing `/spokeline say list the files here` makes Claude answer, and
you hear a short spoken reply.

### Phase 2: spoken answers done properly (2–3 days)
- Smart and Simple summaries (section 2.4).
- Spoken alerts: needs permission, question, finished, error.
- Settings through the plugin's own options: voice, summary mode, which alerts to speak, speaking on or off.
- Status band in the panel: "Speaking…", "Listening…", "Off".

**Done when:** a day of normal use with spoken answers on feels useful, not annoying.

### Phase 3: Ears, push-to-talk, Mac first (1–2 weeks)
- Native helper: microphone, detecting when you start and stop talking, speech-to-text on the device.
- Speech model downloaded once on first use, with the size shown and the user asked first.
- Inbox and session files (section 2.2). Only one Ears runs, even with many chats open.
- Push-to-talk key. The helper needs a system-wide key, which on Mac requires the Accessibility
  permission; if that is too heavy, use a key inside each app instead.
- Mic pauses while Claude speaks.
- Answer U4, U5, U8.

**Done when:** you can hold a key, say "add a test for the login function", and Claude does it and tells you.

### Phase 4: hands-free (1–2 weeks)
- Wake word ("Hey Spokeline", or a word the user chooses).
- Voice commands that never reach Claude: "stop", "repeat", "switch to …", "send" / "cancel" (in check-first mode).
- Interrupting Claude's voice by starting to talk.
- Approve or deny by voice, within the limits from U7.
- Safety: optional "I heard: … — send?" step; voice can never turn off permission boxes.

**Done when:** you can do a 10-minute coding task without touching the keyboard.

### Phase 5: release (1 week + waiting for Apple)
- Signed and notarized Mac helper, so macOS doesn't block it.
- Public repo (GitHub mirror), README, install steps:
  `/plugin marketplace add <repo>` then `/plugin install spokeline@spokeline`.
- Privacy page: what is recorded, where it stays, what is downloaded.
- Windows and Linux builds of Ears after the Mac version is stable.

### Phase 6 (optional): VS Code extension
- A shortcut key that works anywhere in VS Code, and a status-bar icon.
- One-click install of the Claude plugin through the official link
  `vscode://anthropic.claude-code/install-plugin?plugin=spokeline&marketplace=<repo>`.
- Later, the chat-manager features from the first research (search across projects, cost history, …).

---

## 5. Technical choices (proposed, to confirm in Phase 3)

| Need | Proposal | Why | Alternative |
|---|---|---|---|
| Language for Ears | **Rust** | One code base for Mac, Windows and Linux; small, fast programs | Swift (Mac only) |
| Microphone access | `cpal` (Rust audio library) | Works on all three systems | — |
| Speech-to-text | **whisper.cpp** (via `whisper-rs`) | Open source (MIT), fast on Apple Silicon, ~100 languages, runs fully offline | Apple's built-in speech (no download, but needs an app bundle with special permissions) |
| Speech model | `base` (about 140 MB) by default; `small` (about 460 MB) as an option | Good balance of speed and accuracy | `tiny` (about 75 MB) for slow machines |
| Start/stop of speech | Silero VAD, or whisper.cpp's own detection | Cuts silence; less wrong text | — |
| Wake word | openWakeWord (Apache 2.0) | Free for commercial use, runs on device | Porcupine (paid licence) |
| Speaking | `$.audio.speak` (built into mods) | No extra code | Ears speaks, if U1 fails or echo control needs it |
| Mod language | TypeScript | Anthropic publishes the type definitions for mods | Plain JavaScript |

---

## 6. Repo layout

```
Spokeline/
├── .claude-plugin/
│   └── marketplace.json        the repo is its own plugin marketplace
├── plugins/
│   └── spokeline/
│       ├── .claude-plugin/plugin.json
│       ├── hooks/
│       │   ├── hooks.json      points to the mod
│       │   └── register.ts     the mod
│       └── bin/                Ears builds per system (from Phase 3)
├── ears/                       Ears source code (Rust, from Phase 3)
└── docs/
    ├── name-research.md
    ├── plan.md                 this file
    └── findings.md             answers to the unknowns (from Phase 1)
```

---

## 7. Risks

| Risk | How likely | What we do |
|---|---|---|
| Anthropic changes the mods system; its official definitions say "EARLY ACCESS: may change without notice" | Medium | Keep the mod small; pin the Claude Code version we test against; check every Claude Code release |
| A company admin turns off personal mods for its users | Certain for some users | State it clearly in the README; nothing we can do |
| Misheard words become wrong instructions | Medium | Check-first mode; permission boxes always stay on; stop is always one word away |
| Echo: the mic hears Claude's own voice | High without care | Mic paused while speaking (Phase 3); talk-over interruption done carefully (Phase 4) |
| macOS blocks an unsigned helper | High for public users | Apple Developer account (99 USD a year), sign and notarize (Phase 5) |
| Speech model download is large | Certain | Ask first, show the size, offer the smaller model |
| Speech recognition is weak for strong accents | Medium | Language setting; larger model option |

---

## 8. Not doing

- No cloud speech services and no API keys for speech.
- No server or open network port of any kind.
- No reading or storing of login keys.
- No remote/SSH support (D5).
- Not replacing the official Claude panel; Spokeline works inside it.
