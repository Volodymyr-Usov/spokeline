# Spokeline

**Talk to Claude Code and hear short spoken answers back.** Website: [spokeline.dev](https://spokeline.dev)

Spokeline is a plugin for Claude Code on Mac and Windows. It works in the terminal, in the VS Code panel and
in the Claude desktop app. Your speech is turned into text on your own computer; no audio is stored or sent
anywhere.

> Spokeline is an independent project and is not made by Anthropic.

## What it does

- **Speak instead of typing.** Hold a key, or say "Hey Spokeline", then your request.
- **Hear the answer.** When Claude finishes, you hear a short spoken version of the answer. Code, file paths,
  tables and links are not read out.
- **Talk it through first.** A small, fast Claude model talks with you, asks what you mean when something is
  unclear, and sends the task to your chat only after you say yes. While Claude works, it tells you what is
  happening.
- **Control by voice.** "Stop", "repeat", "mute", "yes" / "no" to a permission request (after you switch on
  **Approve by voice** in the settings), "that's all" to switch
  the microphone off, and "switch to *project*" to talk to another open chat (a chat in VS Code also comes
  to the front).

## Requirements

- Claude Code 2.1.299 or later. Spokeline uses Claude Code's plugin API, which Anthropic marks as early access.
- macOS 13 or later, or Windows 10 or 11 (64-bit).
- A microphone. Headphones are not needed.

## Install

In a terminal:

```bash
claude plugin marketplace add Volodymyr-Usov/spokeline
claude plugin install spokeline@spokeline
```

Then open a new Claude chat.

- **Mac:** macOS asks whether **Spokeline Ears** may use the microphone and speech recognition. Allow both.
  A microphone icon appears in the menu bar. The first time Spokeline speaks, it offers a natural-sounding
  voice (about 350 MB, downloaded once). Without it, the built-in macOS voice is used.
- **Windows:** Spokeline first downloads its Windows helper by itself (58 MB, once, from this project's
  releases page; it checks the file's fingerprint before using it). Then it offers to download its speech
  pack: the speech recognition and the natural voice (about 600 MB, downloaded once). Choose **Download**.
  A microphone icon appears in the system tray.

**If it does not hear you:**

- Mac: open **System Settings > Keyboard > Dictation**, turn Dictation on and choose your language once.
  This makes macOS download its on-device speech recognition.
- Windows: open **Settings > Privacy & security > Microphone** and turn on **Let desktop apps access your
  microphone**.

## Use

| Mode | How it works |
|---|---|
| Hands free | Say "Hey Spokeline" (or "Claude"), then your request, then pause. |
| Push to talk (default) | Hold **Control + Option + V** (Windows: **Ctrl + Alt + V**) while you speak, then let go. |
| Off | The microphone stays closed. |

**Switching on and off:** a new chat, or a restart, starts in push to talk: the microphone opens only while
you hold the key. Hands free stays on at a new chat or a restart only if your voice was used in the last 15
minutes. After 15 minutes with no voice request, hands free switches itself off and push to talk takes over.
Change the time, or choose "never", in the `/spokeline` menu (Switch off after: 5, 15, 30 or 60 minutes).
Choose Off in the menu (Listening) to keep the microphone closed; it then stays off after a restart too.

**Conversation:** after the first request you can keep talking without the wake phrase, and you can
interrupt the voice by speaking. Say "that's all" to end the conversation and switch the microphone off.
After 2 minutes of quiet the wake phrase is needed again. While a conversation is on, everything the
microphone hears is sent, including other people in the room.

**The `/spokeline` menu** (type it in any chat) changes the listening mode, spoken answers, the voice, the
microphone, the speakers, which chat your voice goes to, and after how many quiet minutes the microphone
switches off. Tab moves between rows, Enter changes one.

Other commands: `/spokeline say <text>` (send text as if you had said it), `/spokeline here` (send your voice
to this chat), `/spokeline stop`, `/spokeline repeat`, `/spokeline mute`, `/spokeline unmute`.

All settings (key, wake phrases, language, voice, when to speak) are also in `/config` under **Spokeline**.

## How it works

- **The plugin** runs inside Claude Code. It sends what you said to the chat, reads Claude's answer,
  shortens it and speaks it.
- **Spokeline Ears** is a small helper app that listens to the microphone and turns speech into text on
  your computer: Apple's on-device speech recognition on the Mac, and
  [Moonshine](https://github.com/usefulsensors/moonshine) on Windows.
- The natural voice is [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), running on your computer
  with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx).
- The plugin and the helper share small files in `~/.spokeline/`. No server is involved.

## Privacy

- Sound from the microphone is turned into text on your computer. It is never recorded or sent.
- In hands-free mode the microphone listens for the wake phrase while a Claude chat is open (your system's
  microphone indicator shows this). In push-to-talk mode it listens only while you hold the key.
- A new chat or a restart starts in push to talk. Hands free is kept only if your voice was used in the last
  15 minutes, and it switches back to push to talk after 15 minutes with no voice request (change this in
  `/spokeline`).
- What you say is sent to Claude, just like typed text. The voice conversation and the spoken summaries
  use small Claude model calls in your own Claude Code session. Set "How answers are shortened" to
  **simple** in the settings to shorten answers without a model call.
- `~/.spokeline/ears.log` lists what was sent to which chat. You can delete it at any time.

## Development

```bash
./ears/build.sh                                # build the Mac helper (needs the Xcode command line tools)
./ears-windows/build.sh                        # build the Windows helper to test it here (needs the .NET 10 SDK)
./ears-windows/release.sh                      # GitHub builds, tests and publishes the Windows helper; the plugin is pointed at it
claude --plugin-dir ./plugins/spokeline        # run Claude with the plugin from this folder
(cd plugins/spokeline && claude plugin test)   # plugin tests
./ears-windows-tests/run.sh                    # Windows helper tests (run on a Mac too)
```

The design is described in [docs/plan.md](docs/plan.md).

## License

MIT. See [LICENSE](LICENSE). The speech models and engines downloaded at first use have their own
licenses: Kokoro (Apache 2.0), sherpa-onnx (Apache 2.0), Moonshine (MIT).
