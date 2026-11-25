# Spokeline

**Talk to Claude Code and hear short spoken answers back.** Website: [spokeline.dev](https://spokeline.dev)

Spokeline works in the terminal, the VS Code panel and the Claude desktop app, on Mac and Windows. Your
speech is turned into text on your own computer; no audio is stored or sent anywhere.

> Spokeline is an independent project and is not made by Anthropic.

## What it does

- **Speak instead of typing.** Hold a key (Mac: Control + Option + V, Windows: Ctrl + Alt + V), or say
  "Hey Spokeline" or "Claude", then your request.
- **Hear the answer.** When Claude finishes, you hear a short spoken version. Code, file paths, tables and
  links are not read out.
- **Talk it through first.** A small, fast Claude model talks with you, asks what you mean when something is
  unclear, and sends the task to the chat only after you say yes. While Claude works, it tells you what is
  happening.
- **Control by voice.** "Stop", "repeat", "mute", "that's all" (microphone off), and "switch to *name*" to
  talk to another open chat.
- **Closed when you are not using it.** A new chat or a restart starts in push to talk: the microphone opens
  only while you hold the key. Hands free is kept only if your voice was used in the last 15 minutes, and it
  switches back to push to talk after 15 quiet minutes (5, 15, 30, 60 minutes or never, in `/spokeline`).

### Examples

1. "Hey Spokeline, why are the tests failing?" Claude looks into it, and you hear a two-sentence answer.
2. "Claude, rename the config loader to settings loader and run the tests." The voice assistant repeats the
   task in its own words, you say "yes", and it goes to the chat.
3. "Hey Spokeline, in the background, check which pages still use the old logo." A helper agent checks
   while you keep working, and Spokeline tells you what it found.
4. "Switch to the docs chat." Your voice now goes to that chat, and its VS Code window comes to the front.

## Set up

Install it in Claude Code:

```
/plugin install spokeline --marketplace Volodymyr-Usov/spokeline
```

- **Mac:** at the first start, macOS asks whether Spokeline Ears may use the microphone and speech
  recognition. Allow both. Spokeline then offers a natural-sounding voice (about 350 MB, downloaded once).
- **Windows:** at the first start, Spokeline downloads its Windows helper (58 MB, once) and then offers its
  speech pack (about 600 MB, downloaded once).
- Settings: type `/spokeline` for the menu, or open `/config` and find **Spokeline**.

## What Spokeline does on your computer

This section lists everything Spokeline sends, runs and writes, so you can check it before you install.

### What it sends, and where

- **Your spoken words go to the chat you are talking to, as your own message**, the same as typing them.
  Spokeline adds nothing to them. In a voice conversation, the voice assistant may first put your request
  into clear words; it is sent only after you say "yes".
- **One addition to Claude's work:** if you say something by voice while Claude is busy with a task,
  Spokeline passes it on with the result of Claude's next step, as: *While you were working, the user changed
  course (by voice): "…"*.
- **Small Claude model calls**, made through Claude Code itself with your own Claude account (Haiku; for the
  voice conversation, Sonnet when Haiku is busy). Nothing goes to any other AI service. They are used to:
  - shorten Claude's answer before it is spoken (set "How answers are shortened" to **simple** to do this
    without a model call);
  - hold the voice conversation. That call gets what you just said, the conversation so far, the project
    folder's name, the last 40 messages of this chat, what Claude is doing now, and the names of your other
    open chats;
  - say in a few words what Claude or a helper is doing right now.
- **Helper agents:** when you ask for a background check, Spokeline starts at most 2 helper agents in this
  chat. Each gets your task plus this instruction: *"You are a background helper: the developer is busy with
  other work and will hear a short spoken summary of your answer. Do the research or checks needed, change
  no files unless the task says so, and end with a short, plain answer: what you found, with the key numbers
  or facts."*
- **Downloads** (nothing else goes over the network, and there is no analytics):
  - the natural voice and, on Windows, the speech recognition: open-source models and the sherpa-onnx
    engine from github.com/k2-fsa/sherpa-onnx, only after you choose Download;
  - on Windows, the Spokeline helper from
    [this project's releases page](https://github.com/Volodymyr-Usov/spokeline/releases). It is checked
    against a SHA-256 fingerprint before it is used.

### Programs it runs, and why

- **Mac:**
  - the Spokeline Ears helper in this plugin (`bin/SpokelineEars.app`, started with `/usr/bin/open`). It
    listens to the microphone, turns speech into text with Apple's on-device recognition, removes the
    computer's own voice from what the microphone hears, and watches the push-to-talk key;
  - `/usr/bin/say`, to list the built-in voices and to speak when the natural voice is off;
  - `sherpa-onnx-offline-tts` from the downloaded engine in `~/.spokeline/voice`, to make the natural voice.
    The sound is played by the helper, or by `/usr/bin/afplay`, and stopped with `/usr/bin/pkill`;
  - `/bin/mkdir` and `/bin/rm`, for its own folders and temporary sound files;
  - VS Code's own `code` command, to bring a chat's VS Code window to the front when you switch chats.
- **Windows:**
  - the Spokeline helper (`SpokelineEars.exe` in `%USERPROFILE%\.spokeline\bin`). It does the same jobs,
    with the open-source Moonshine speech recognition;
  - `curl.exe` (or PowerShell, if curl is missing), to download the helper, and `certutil.exe`, to check
    its fingerprint;
  - `cmd.exe`, to start the helper and to move or delete its download;
  - VS Code's own command line (its `Code.exe`), to bring a chat's VS Code window to the front when you
    switch chats.

### Files it writes

Only in `~/.spokeline` (Windows: `%USERPROFILE%\.spokeline`):

- `config.json`: Spokeline's own settings, such as the listening mode, which chat your voice goes to, when the
  voice was last used and after how many quiet minutes the microphone switches off;
- `sessions/`, `inbox/`, `live/`: one small status file per open chat, what you said while it waits to be
  sent, and the words while you are still speaking;
- `permission/`: requests and spoken answers for "Approve by voice";
- `voice/`: the downloaded speech engine and voices, and temporary sound files;
- `bin/` (Windows only): the downloaded helper;
- `ears.json`, `ears.log`, `log-*.txt`: the helper's status and logs, including what was sent to which
  chat. You can delete them at any time.

It does not change Claude Code's settings, your project's files, or any instructions file such as
`CLAUDE.md`.

### The permission hook ("Approve by voice", off unless you switch it on)

With **Approve by voice** switched on in the settings, and only while you are talking to a chat by voice,
Spokeline reads Claude's permission requests aloud and lets you answer "yes" or "no". "Yes" allows that one
request, and "no" refuses it. With no spoken answer within the wait time (20 seconds by default), or in any
other case, the normal permission box appears. It never changes your permission settings or mode.

The hook is `hooks/permission-hook.sh` on the Mac, which runs the helper in this plugin, and
`hooks/permission-hook.mjs` on Windows, which needs Node.js. It reads and writes only files in
`~/.spokeline/permission`.

## Privacy

- Microphone sound is turned into text on your computer. It is never recorded or sent.
- In hands-free mode, the microphone listens for the wake phrase while a Claude chat is open. In
  push-to-talk mode, it listens only while you hold the key.
- A new chat or a restart starts in push to talk. Hands free is kept only if your voice was used in the last
  15 minutes, and it switches back to push to talk after 15 minutes with no voice request; change the time in
  `/spokeline`.
- During a voice conversation, everything the microphone hears is sent as text, including other people in
  the room. Say "that's all" to end it. After 2 minutes of quiet, the wake phrase is needed again.

## Support and license

- Website: [spokeline.dev](https://spokeline.dev)
- Source and issues: [github.com/Volodymyr-Usov/spokeline](https://github.com/Volodymyr-Usov/spokeline)
- License: MIT (see `LICENSE`). The downloaded speech models and engines have their own licenses: Kokoro
  (Apache 2.0), sherpa-onnx (Apache 2.0), Moonshine (MIT).
