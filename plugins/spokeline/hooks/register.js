// Spokeline mod: runs inside Claude Code (terminal, VS Code panel, desktop app).
//
// What it does:
//   - picks up what you said (written by the "Ears" helper into ~/.spokeline/inbox/<chat id>.jsonl)
//     and sends it to Claude as your own message
//   - "stop" stops Claude or the voice; "repeat" repeats; "yes"/"no" answer permission requests
//   - when a turn ends, speaks a short version of Claude's answer (no code, paths or tables)
//   - speaks alerts: permission needed, a question from Claude, errors
//   - writes a small "I'm alive" file per chat so Ears knows which chats exist and when to pause the mic
//
// Files (all under ~/.spokeline/):
//   sessions/<chat id>.json   written here every 2 s   read by Ears
//   inbox/<chat id>.jsonl     written by Ears          read here 3 times a second
//   config.json               written here and by Ears (mode, hotkey, language, wake phrase, target chat)

import {
  basename,
  cleanForSpeech,
  describeQuestion,
  describeTool,
  isShortPlain,
  parseVoiceCommand,
  SUMMARY_SYSTEM,
  ACK_SYSTEM,
  STATUS_SYSTEM,
  PARTNER_SYSTEM,
  parseTalk,
  plainTalk,
  switchRequest,
  matchChat,
  sayableTitle,
  noSuchChat,
  chooseVoice,
  prepareForVoice,
  commandSuggestions,
  micLine,
  micHearing,
  micLevel,
  micWords,
  historyRows,
  helperLine,
  HELPER_STATUS_SYSTEM,
  parseUnknownWords,
  fixUnknownWords,
  splitSentences,
  NATURAL_VOICES,
  IDLE_OFF_CHOICES,
  idleOffMinutes,
  idleOffLabel,
  quietTooLong,
  startMode,
} from './text.js'

const PLUGIN = 'spokeline'

let opts = {}
// The same as the wake_phrase default in plugin.json. "anthropic" still works when a person adds it.
const DEFAULT_WAKE_PHRASES = 'claude, hey claude, ok claude, hey spokeline'
let base = ''              // ~/.spokeline
let sessionId = ''
let cwd = ''
let ready = false
let mode = 'off'           // off | push_to_talk | hands_free; the start value comes from config.json (startMode)
let idleOff = 15           // minutes of quiet before the microphone switches off (0: never), from config.json
let activeMarkedAt = 0     // when this chat last wrote activeAt, so a busy conversation writes it once a minute

let currentTurnId = null   // the main loop's running turn, so "stop" can end it
let busy = false
let lastActive = 0
let lastPromptByVoice = false
let pendingNotes = []      // what you said while Claude was working, handed to it at its next step
let activity = []          // what Claude did lately in this turn ("run the command npm test"), for spoken status
let activitySeen = 0       // how much of it the last spoken status covered
let lastVoiceText = ''     // what you last said, for the quick spoken "got it"
let muted = false

let speaking = false
let speakAbort = null
let lastSpoken = ''
let bestVoice = ''        // the most natural installed system voice, chosen at start

let lastSeq = 0            // highest inbox line handled
let lastInboxSize = -1
let ticking = false

let approval = null        // { answer: null | 'yes' | 'no' } while waiting for a spoken yes/no
let draftWaiting = false   // "check before sending": text is in the box, waiting for send/cancel

function inboxPath() { return base + '/inbox/' + sessionId + '.jsonl' }
function sessionPath() { return base + '/sessions/' + sessionId + '.json' }
function configPath() { return base + '/config.json' }

function shouldSpeak() {
  if (muted || opts.speak_answers === false) return false
  return opts.speak_when === 'always' || lastPromptByVoice
}

export function register(on, options) {
  opts = options || {}
  // A new chat or a reload no longer switches the microphone on: setup() takes the shared mode from
  // config.json only when the voice was used within the quiet time; otherwise it starts off.
  mode = 'off'

  on('session.start', async ($, e, next) => {
    // The microphone line is drawn as an own row above the prompt now: clear an old status line.
    try { $.ui.status(undefined) } catch { }
    await setup($)
    try {
      await $.command.register({
        name: 'spokeline',
        description: 'Voice control: status, say <text>, stop, repeat, mute, unmute, here, listen off|ptt|handsfree',
        argumentHint: '[status|say <text>|stop|repeat|mute|unmute|here|listen <mode>]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('could not add /spokeline: ' + errText(err))
    }
    return next(e)
  })

  // The list of /spokeline commands while you type (below Claude Code's own rows).
  on('prompt.autocomplete', async ($, e, next) => {
    const r = await next(e)
    let mine = []
    try { mine = commandSuggestions(e.text, e.token, e.start, Object.keys(NATURAL_VOICES)) } catch {}
    return mine.length ? { suggestions: [...r.suggestions, ...mine] } : r
  })

  // The /spokeline menu: a small window in the chat. Tab (or the arrows in the terminal) moves between rows,
  // Enter changes one, and in the terminal 1 to 5 change a row directly.
  on('ui.render', { component: 'Pane', requestId: MENU }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    return h(Box, { flexDirection: 'column' }, ...menuRows($, { Text, Button }, e.surface))
  })
  on('ui.close', { id: MENU }, async ($, e, next) => { menuOpen = false; return next(e) }).catch(($, e, next) => next(e))

  // The microphone line, always on screen above the prompt: the microphone sign first, always, with a raised
  // green light while the microphone hears you speaking; then what it is doing, or a short message (speaking, say
  // yes or no) that takes the text's place for a moment.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const t = overlay !== undefined ? overlay : micText
    const working = [...helpers.values()].filter(x => !x.done)
    if (!t && !working.length) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    // An empty row, then a thin line across, between the chat above and Spokeline's rows (asked for by voice
    // on 24.11.2026: the rows ran straight into the chat text).
    const width = Math.max(20, Number(e.props && e.props.bodyColumns) || 80)
    const rows = [h(Text, {}, ' '), h(Text, { dimColor: true }, '─'.repeat(width))]
    if (t) {
      const text = t.replace(/^(?:🎙|🔊|⬇|🔇)\s*/u, '')
      const off = / off$|not running|not open/.test(text)
      // The sign, always plain, then three bars of rising height: grey while it does not hear you, and
      // green from the left by how loud you speak (one bar quiet, two normal, three loud).
      const bars = ['▂', '▄', '▆'].map((b, i) => i < micBars
        ? h(Text, { color: 'rgb(80,220,100)' }, b)
        : h(Text, { color: 'gray', dimColor: true }, b))
      // While Spokeline speaks: a speaker sign after the bars (the same width is kept blank otherwise).
      rows.push(h(Box, {}, h(Text, {}, ' 🎙 '), ...bars, h(Text, {}, speaking ? ' 🔊' : '   '), h(Text, { dimColor: off }, ' ' + text)))
      // What you are saying, in full: as many rows as it needs, the newest words kept when it is very long.
      const cols = Math.max(20, Number(e.props && e.props.bodyColumns) || 80)
      const maxRows = Math.max(4, Number(e.props && e.props.maxRows) || 12)
      // Your last three questions, the current one highlighted: what you are saying now (green), or else the
      // last one you said (bold). At most 16 rows, fewer when the screen has less room.
      const words = micWords(earsInfo, micLive, Date.now(), sessionId)
      const room = Math.min(16, Math.max(2, maxRows - 4 - working.length))   // 4: the space, the line, the microphone row, one spare
      for (const q of historyRows(voiceHistory, words, Math.floor((cols - 6) * 0.9), room)) {
        rows.push(h(Box, { paddingLeft: 4 }, h(Text, q.current ? { color: q.speaking ? 'rgb(80,220,100)' : 'cyan', bold: true } : { dimColor: true },(q.current ? '▸ ' : '  ') + q.text)))
      }
    }
    // Background checks at work: one row each, so you can see they run.
    for (const x of working) {
      rows.push(h(Box, {}, h(Text, { color: 'cyan' }, ' ⚙  '), h(Text, { dimColor: true, wrap: 'truncate-end' },
        helperLine(x.label, (Date.now() - x.startedAt) / 1000, x.steps[x.steps.length - 1] || ''))))
    }
    return h(Box, { flexDirection: 'column' }, ...rows)
  })

  on('command.run', { command: 'spokeline' }, async ($, e) => {
    return slashCommand($, String(e.args || '').trim())
  })

  on('session.end', async ($, e, next) => {
    ready = false
    stopSpeaking()
    try { await $.fs.write(sessionPath(), JSON.stringify({ sessionId, ended: true, heartbeat: 0 })) } catch { /* ignore */ }
    return next(e)
  })

  // Remember whether the latest prompt came from the voice, and when the chat was last used.
  on('prompt.submit', async ($, e, next) => {
    if (!ready) await setup($)
    // A background helper of the voice partner finished: the partner tells you; the main chat is not bothered.
    // (It arrives as a hand-back message naming the helper: <agent-message from="<agentId>">.)
    // (Never a message the person wrote: typed here, in VS Code or the desktop app, or from the phone.)
    const own = ['plugin', 'composer', 'sdk', 'bridge']
    if (e.origin && !own.includes(e.origin.kind) && isHelperNotice(String(e.text || ''))) {
      await dlog($, 'kept the helper hand-back out of the main chat (' + e.origin.kind + '): ' + JSON.stringify(String(e.text || '').slice(0, 200)))
      return { drop: 'a Spokeline background helper finished; the voice partner reports it' }
    }
    if (!e.isMeta) {
      const o = e.origin
      lastPromptByVoice = !!(o && o.kind === 'plugin' && typeof o.name === 'string' && o.name.startsWith(PLUGIN))
      if (!lastPromptByVoice && typeof e.text === 'string' && e.text.trim()) lastTask = e.text.trim().slice(0, 500)
      lastActive = Date.now()
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      currentTurnId = e.turnId
      busy = true
      stopSpeaking()
      await heartbeat($)
      activity = []
      activitySeen = 0
      if (ready && shouldSpeak() && lastVoiceText) {
        acknowledge($, e.turnId)
        $.clock.after(STATUS_EVERY_MS, () => statusTick($, e.turnId, Date.now()))
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined && helpers.has(e.agentId)) helperFinished($, e)
    if (e.agentId === undefined) {
      busy = false
      currentTurnId = null
      if (pendingNotes.length) {
        const notes = pendingNotes.splice(0).join(' ')
        await dlog($, 'note not delivered during the turn, sending it now: ' + notes)
        submitVoice($, notes)
      }
      await dlog($, 'turn.complete reason=' + e.reason + ' aborted=' + e.isAborted + ' speak=' + shouldSpeak() + ' answerChars=' + String(e.answer || '').length)
      if (ready && shouldSpeak()) {
        if (e.reason === 'answer' && !e.isAborted) {
          speakAnswer($, e.answer)
        } else if (e.reason === 'error') {
          speak($, 'Sorry, the request failed.')
        } else if (e.reason === 'refusal') {
          speak($, 'Claude declined that request.')
        }
      }
      await heartbeat($)
    }
    return next(e)
  })

  // Remember what Claude is doing (for spoken status), and hand it what you said while it worked:
  // the words ride along with the result of its next action, so it reads them right away.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined && helpers.has(e.agentId)) {
      const h = helpers.get(e.agentId)
      h.steps.push(describeTool(e.tool, e.input))
      if (h.steps.length > 8) h.steps = h.steps.slice(-8)
      $.ui.invalidate('ui.render')
    }
    if (e.agentId !== undefined || !ready) return next(e)
    activity.push(describeTool(e.tool, e.input))
    if (activity.length > 12) { activitySeen = Math.max(0, activitySeen - (activity.length - 12)); activity = activity.slice(-12) }
    const r = await next(e)
    if (pendingNotes.length && r && r.deny === undefined && r.result !== undefined) {
      const notes = pendingNotes.splice(0).join(' ')
      await dlog($, 'note handed to Claude: ' + notes)
      return { ...r, context: [...(r.context || []), 'While you were working, the user changed course (by voice): "' + notes + '". Take it into account now, and say briefly in your answer how you used it.'] }
    }
    return r
  }).catch(async ($, e, next) => next(e))

  // Read Claude's questions aloud.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (ready && shouldSpeak()) {
      const q = describeQuestion(e)
      if (q) speak($, 'Claude asks: ' + q)
    }
    return next(e)
  }).catch(async ($, e, next) => next(e))

}

// ---------------------------------------------------------------- setup

// The VS Code panel and the desktop app may attach their screen a moment after the session starts,
// so when no screen is attached yet we look again every second for a minute. A `claude -p` run never
// gets a screen, so Spokeline stays off there.
let setupTries = 0
let setupWaiting = false
let notReadyReason = 'starting'

async function setup($) {
  if (ready || setupWaiting) return
  setupTries += 1
  let surfaces = []
  try { surfaces = (await $.session.surfaces()) || [] } catch (err) { surfaces = []; notReadyReason = 'could not ask which screen is attached: ' + errText(err) }
  if (surfaces.length === 0) {
    if (notReadyReason === 'starting') notReadyReason = 'no screen is attached to this session (a claude -p run?)'
    if (setupTries < 60) {
      setupWaiting = true
      $.clock.after(1000, async () => { setupWaiting = false; await setup($) })
    }
    return
  }
  await activate($)
}

async function activate($) {
  if (ready) return
  try {
    isWin = (await $.env.get('OS')) === 'Windows_NT'
    // On Windows use the profile folder; HOME there may be a Git Bash path such as /c/Users/me.
    const home = isWin ? await $.env.get('USERPROFILE') : await $.env.get('HOME')
    if (!home) { notReadyReason = 'the home folder is unknown'; return }
    base = home.replace(/\\/g, '/') + '/.spokeline'
    sessionId = await $.session.id()
    cwd = await $.session.cwd()
    startedAt = Date.now()
    try {
      const env = await $.process.hookEnv()
      pluginRoot = (env.CLAUDE_PLUGIN_ROOT || '').replace(/\\/g, '/')
      pluginData = (env.CLAUDE_PLUGIN_DATA || '').replace(/\\/g, '/')
    } catch { pluginRoot = ''; pluginData = '' }
    // Windows: the helper program is downloaded at the first start; this runs again when it is here.
    if (isWin && !(await findWindowsHelper($))) return
    await makeDirs($, [base + '/sessions', base + '/inbox', base + '/permission', base + '/voice/tmp'])

    bestVoice = isWin ? '' : await pickVoice($)
    try { const st = JSON.parse(await $.fs.read(base + '/voice/status.json')); installing = st.state === 'downloading' } catch { installing = false }
    lastSeq = await highestSeq($)
    // A chat that was just opened must not take your voice away from the chat you are talking with:
    // it becomes the voice's chat once you type or talk in it (or run /spokeline here). After a
    // /reload-plugins the chat keeps the time it was last used.
    try { lastActive = Number(JSON.parse(await $.fs.read(sessionPath())).lastActive) || 0 } catch { lastActive = 0 }
    await loadHelpers($)
    ready = true

    // The microphone stays as the other chats have it if the voice was used within the quiet time
    // (a /reload-plugins in the middle of a conversation); after a restart or a long break it starts off.
    const shared = await readShared($)
    idleOff = idleOffMinutes(shared)
    mode = opts.listen === 'off' ? 'off' : startMode(shared, Date.now())
    await dlog($, 'start: microphone ' + mode + (shared && shared.mode && shared.mode !== mode ? ' (was ' + shared.mode + ', quiet too long)' : ''))
    await writeConfig($, {})
    await heartbeat($)
    $.clock.every(300, async () => { await tick($) })
    keepHelperRowsFresh($)
    $.clock.every(2000, async () => { await heartbeat($) })
    if (mode !== 'off') await startEars($)
    if (isWin && mode !== 'off' && !installing && !(await naturalVoiceReady($))) offerNaturalVoice($)
  } catch (err) {
    notReadyReason = 'start-up failed: ' + errText(err)
    $.ui.log('Spokeline could not start: ' + errText(err))
  }
}

// Pick the most natural installed voice: "(Premium)" beats "(Enhanced)" beats the basic ones.
// Only voices for the user's language (or English) count. Empty means the system default.
async function pickVoice($) {
  try {
    const r = await $.process.run(['/usr/bin/say', '-v', '?'])
    if (r.exitCode !== 0) return ''
    return chooseVoice(r.stdout, typeof opts.language === 'string' ? opts.language : '')
  } catch { return '' }
}

async function highestSeq($) {
  try {
    if (!(await $.fs.exists(inboxPath()))) return 0
    const text = await $.fs.read(inboxPath())
    let max = 0
    for (const line of text.split('\n')) {
      try { const m = JSON.parse(line); if (m.seq > max) max = m.seq } catch { /* skip */ }
    }
    return max
  } catch { return 0 }
}

async function writeConfig($, extra) {
  let current = {}
  try {
    if (await $.fs.exists(configPath())) current = JSON.parse(await $.fs.read(configPath())) || {}
  } catch { current = {} }
  const next = {
    ...current,
    mode,
    hotkey: typeof opts.hotkey === 'string' && opts.hotkey ? opts.hotkey : 'ctrl+option+v',
    wakePhrase: typeof opts.wake_phrase === 'string' && opts.wake_phrase ? opts.wake_phrase : DEFAULT_WAKE_PHRASES,
    language: typeof opts.language === 'string' ? opts.language : '',
    pauseSeconds: Math.max(1, Math.min(8, Number(opts.pause_seconds) || 3)),
    bargeIn: opts.barge_in !== false,
    ...extra,
    updatedAt: Date.now(),
  }
  try { await $.fs.write(configPath(), JSON.stringify(next, null, 2)) } catch (err) { $.ui.log('config not saved: ' + errText(err)) }
}

async function readShared($) {
  try { return JSON.parse(await $.fs.read(configPath())) || null } catch { return null }
}

/// The voice was used (a request arrived, or listening was switched on): the quiet time starts again for
/// every chat. Written at most once a minute while a conversation goes on, at once when `now` is asked.
async function markActive($, now = false) {
  if (!now && Date.now() - activeMarkedAt < 60000) return
  activeMarkedAt = Date.now()
  await writeConfig($, { activeAt: activeMarkedAt })
}

/// Every 2 s: take the microphone mode other chats or the tray menu set, and switch the microphone off
/// when it has been quiet for longer than the chosen time.
async function syncShared($) {
  const shared = await readShared($)
  if (!shared) return
  idleOff = idleOffMinutes(shared)
  const theirs = ['off', 'push_to_talk', 'hands_free'].includes(shared.mode) ? shared.mode : null
  if (theirs && theirs !== mode) {
    const switchedOn = mode === 'off'
    mode = theirs
    // Switched on from the tray menu or another chat after a long quiet: that is use, not a stale setting.
    if (switchedOn && quietTooLong(shared, Date.now())) { await markActive($, true); shared.activeAt = activeMarkedAt }
    lastMicRead = 0
    if (menuOpen) $.ui.invalidate('ui.render')
  }
  if (mode !== 'off' && quietTooLong(shared, Date.now())) {
    await dlog($, 'microphone off after ' + idleOff + ' quiet minutes')
    await setListening($, 'off')
    $.ui.toast('Spokeline: microphone off after ' + idleOff + ' quiet minutes. Turn it on again with /spokeline.')
  }
}

async function heartbeat($) {
  if (!ready) return
  const info = {
    sessionId,
    title: basename(cwd) || 'Claude',
    cwd,
    lastActive,
    busy,
    speaking,
    speakingText: speaking ? lastSpoken.slice(0, 600) : '',
    // A proposed task counts as "waiting for your yes" for 2 minutes; after that a short word needs the wake phrase again.
    awaitingAnswer: !!approval || draftWaiting || (!!draftTask && Date.now() - draftAt < 120000),
    ackSeq: lastSeq,
    muted,
    voiceFlow: voiceFlow(),
    approvalWaitSeconds: Math.max(5, Math.min(120, Number(opts.approval_wait_seconds) || 20)),
    // Where this chat is shown (terminal, vscode, desktop): only a VS Code window is brought forward on a switch.
    surfaces: await mySurfaces($),
    startedAt,
    heartbeat: Date.now(),
  }
  try { await $.fs.write(sessionPath(), JSON.stringify(info)) } catch { /* try again in 2 s */ }
  try { await syncShared($) } catch (err) { $.ui.log('quiet check: ' + errText(err)) }
}

let startedAt = 0   // when Spokeline started in this chat: among chats with the same name, the newest is preferred

async function mySurfaces($) {
  try { return [...((await $.session.surfaces()) || [])] } catch { return [] }
}

// ---------------------------------------------------------------- switching chats
//
// Your voice goes to one chat at a time (config.json targetSessionId, which Ears follows). You switch by
// voice ("switch to photobook", or in your own words to the voice assistant) or with the Chat row of the
// /spokeline menu. A switch by voice also brings that chat's VS Code window to the front; chats in a
// terminal stay where they are. The chat that is switched to does that itself: it sees `raise` in
// config.json and opens its own folder with VS Code's `code` command, which brings forward the window that
// has the folder open.

/** The chats with Spokeline running now (their heartbeat is under 8 seconds old), from ~/.spokeline/sessions. */
async function openChats($) {
  const out = []
  let entries = []
  try { entries = (await $.fs.list(base + '/sessions')) || [] } catch { return out }
  for (const e of entries) {
    if (!e || e.kind !== 'file' || !String(e.name).endsWith('.json')) continue
    try {
      const s = JSON.parse(await $.fs.read(base + '/sessions/' + e.name))
      if (s && s.sessionId && Date.now() - (Number(s.heartbeat) || 0) < 8000) {
        // `surfaces` is written only by the current Spokeline: a chat without it runs an older one (it cannot
        // bring its window forward) until /reload-plugins there.
        const surfaces = Array.isArray(s.surfaces) ? s.surfaces : []
        out.push({ id: String(s.sessionId), title: String(s.title || 'Claude'), cwd: String(s.cwd || ''), lastActive: Number(s.lastActive) || 0,
          busy: !!s.busy, surfaces, hasScreen: surfaces.length > 0, startedAt: Number(s.startedAt) || 0 })
      }
    } catch { /* being written: skip it this time */ }
  }
  return out.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.id.localeCompare(b.id))
}

/** Sends your voice to `chat`. By voice: says so, and its VS Code window comes to the front. The chat it came
 *  from is kept, so "switch me back" knows where to go. */
async function switchChat($, chat, { byVoice, say } = {}) {
  const from = (earsInfo && earsInfo.target) || sessionId
  await writeConfig($, {
    targetSessionId: chat.id,
    ...(from && from !== chat.id ? { previousTargetSessionId: from } : {}),
    ...(byVoice ? { raise: { sessionId: chat.id, at: Date.now() } } : {}),
  })
  lastMicRead = 0
  await dlog($, 'voice now goes to ' + chat.title + ' (' + chat.id + ')' + (byVoice ? ' by voice' : ' from the menu'))
  if (byVoice) speak($, say || 'Okay, now talking to ' + sayableTitle(chat.title) + '.')
}

/** The chat your voice came from before the last switch, when it is still open. */
async function previousChat($, chats) {
  let id = ''
  try { id = String((JSON.parse(await $.fs.read(configPath())) || {}).previousTargetSessionId || '') } catch { id = '' }
  return (id && id !== sessionId && chats.find(c => c.id === id)) || null
}

/** Says the open chats when the name you said fits none of them (or two equally). */
function switchFailed($, name, chats) {
  speak($, noSuchChat(name, chats.filter(c => c.id !== sessionId)))
}

let configSeenAt = 0
let raisedAt = 0
/** This chat was switched to by voice: bring its VS Code window to the front (only once per switch). */
async function checkRaise($) {
  let st = null
  try { st = await $.fs.stat(configPath()) } catch { return }
  const mtime = st && typeof st.mtimeMs === 'number' ? st.mtimeMs : 0
  if (!mtime || mtime === configSeenAt) return
  configSeenAt = mtime
  let raise = null
  try { raise = (JSON.parse(await $.fs.read(configPath())) || {}).raise } catch { return }
  const at = Number(raise && raise.at) || 0
  if (!raise || raise.sessionId !== sessionId || at <= raisedAt || Date.now() - at > 15000) return
  raisedAt = at
  await bringForward($)
}

/**
 * Brings this chat's VS Code window to the front by opening its folder with VS Code's own command line
 * (`code <folder>` focuses the window that already has the folder open). The program is found from the
 * VS Code that runs this chat (VSCODE_NLS_CONFIG names a file inside it), so nothing has to be on the PATH.
 * Does nothing for a chat in a terminal or the desktop app.
 */
async function bringForward($) {
  if (!(await mySurfaces($)).includes('vscode')) return
  let app = ''
  try { app = String(JSON.parse(await $.env.get('VSCODE_NLS_CONFIG')).defaultMessagesFile || '') } catch { app = '' }
  app = app.replace(/\\/g, '/').replace(/\/out\/[^/]*$/, '')          // .../resources/app
  if (!app || !cwd) { await dlog($, 'cannot bring the VS Code window forward: VS Code not found'); return }
  let argv = null
  let env = undefined
  if (isWin) {
    // As VS Code's own bin\code.cmd does: Code.exe runs its command-line script as a plain program.
    const root = app.replace(/\/resources\/app$/i, '')
    let exe = ''
    try { exe = ((await $.fs.list(root)) || []).map(e => e.name).find(n => /^code.*\.exe$/i.test(n)) || '' } catch { exe = '' }
    if (exe) { argv = [root + '/' + exe, app + '/out/cli.js', cwd]; env = { ELECTRON_RUN_AS_NODE: '1' } }
  } else {
    for (const name of ['code', 'code-insiders']) {
      if (await $.fs.exists(app + '/bin/' + name)) { argv = [app + '/bin/' + name, cwd]; break }
    }
  }
  if (!argv) { await dlog($, 'cannot bring the VS Code window forward: its command line was not found in ' + app); return }
  try {
    const r = await $.process.run(argv, { timeoutMs: 20000, ...(env ? { env } : {}) })
    await dlog($, 'VS Code window brought forward (' + cwd + '), exit ' + r.exitCode + (r.stderr ? ': ' + String(r.stderr).slice(0, 200) : ''))
  } catch (err) { await dlog($, 'could not bring the VS Code window forward: ' + errText(err)) }
}

async function startEars($) {
  try {
    if (!pluginRoot) return
    const target = isWin ? earsProgram() : pluginRoot + '/bin/SpokelineEars.app'
    if (!(await $.fs.exists(target))) {
      $.ui.log('the Ears helper is missing, so the microphone is off (' + target + ')')
      return
    }
    // Starts it once; if it is already running, the new copy quits at once.
    const r = isWin
      ? await $.process.run(['cmd.exe', '/c', 'start', '', target.replace(/\//g, '\\')])
      : await $.process.run(['/usr/bin/open', '-g', '-j', target])
    if (r.exitCode !== 0) $.ui.log('could not start the Ears helper: ' + (r.stderr || r.exitCode))
  } catch (err) {
    $.ui.log('could not start the Ears helper: ' + errText(err))
  }
}

// ---------------------------------------------------------------- the two systems
//
// The plugin is the same on macOS and Windows; only the helper program differs:
// macOS: bin/SpokelineEars.app (Swift), inside the plugin.
// Windows: SpokelineEars.exe (C#). At 58 MB it is too big to keep inside the plugin, which every Mac user
// downloads too, so it is a download on the project's GitHub releases page. The first start on Windows
// fetches it into ~/.spokeline/bin, checks its SHA-256 fingerprint against WIN_EARS, and only then uses it.
// ears-windows/release.sh publishes a new build and rewrites the WIN_EARS line. A copy built on this
// computer by ears-windows/build.sh (bin/windows/SpokelineEars.exe in the plugin folder) is used first.

const WIN_EARS = { version: '0.1.0', sha256: 'a699f96d877585480f81fb173862ca366d6e41a2b85b3b38c68db98a7ba50809' }
const WIN_EARS_URL = 'https://github.com/Volodymyr-Usov/spokeline/releases/download/ears-windows-' + WIN_EARS.version + '/SpokelineEars.exe'
let isWin = false
let pluginData = ''
let winEars = ''              // where the Windows helper is on this PC
let winDownloading = false

function earsProgram() {
  return isWin ? winEars : pluginRoot + '/bin/SpokelineEars.app/Contents/MacOS/SpokelineEars'
}

const winPath = p => p.replace(/\//g, '\\')

async function fileExists($, p) {
  try { return Boolean(p) && (await $.fs.exists(p)) } catch { return false }
}

/** True when the Windows helper is on this PC. Otherwise starts its download (once) and says false. */
async function findWindowsHelper($) {
  const built = pluginRoot + '/bin/windows/SpokelineEars.exe'
  if (pluginRoot && (await fileExists($, built))) { winEars = built; return true }
  winEars = base + '/bin/SpokelineEars-' + WIN_EARS.version + '.exe'
  if (await fileExists($, winEars)) return true
  notReadyReason = 'downloading its Windows helper (58 MB, once). It switches on by itself when done.'
  if (winDownloading) return false
  winDownloading = true
  $.clock.after(10, async () => {
    const ok = await downloadWindowsHelper($, winEars)
    winDownloading = false
    if (ok) await activate($)
  })
  return false
}

async function downloadWindowsHelper($, dest) {
  const part = dest + '.part'
  const fail = async why => {
    notReadyReason = 'could not download its Windows helper (' + why + '). It tries again at your next message.'
    $.ui.log('Spokeline: could not download the Windows helper from ' + WIN_EARS_URL + ': ' + why)
    $.ui.toast('Spokeline: could not download its Windows helper (' + why + '). It tries again at your next message.')
    try { await $.process.run(['cmd.exe', '/c', 'del', '/f', '/q', winPath(part)]) } catch { /* not there */ }
    return false
  }
  $.ui.toast('Spokeline: downloading its Windows helper (58 MB, once)…')
  try {
    let r
    try {
      // curl is part of Windows 10 (since 2018) and Windows 11.
      r = await $.process.run(['curl.exe', '-fsSL', '--retry', '3', '--create-dirs', '-o', winPath(part), WIN_EARS_URL], { timeoutMs: 600000 })
    } catch {
      const q = s => "'" + s.replace(/'/g, "''") + "'"
      const dir = winPath(dest.slice(0, dest.lastIndexOf('/')))
      r = await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
        "$ProgressPreference='SilentlyContinue'; New-Item -ItemType Directory -Force -Path " + q(dir) + ' | Out-Null; ' +
        'Invoke-WebRequest -UseBasicParsing -Uri ' + q(WIN_EARS_URL) + ' -OutFile ' + q(winPath(part))], { timeoutMs: 600000 })
    }
    if (r.exitCode !== 0) return await fail('the download stopped: ' + String(r.stderr || r.exitCode).trim().slice(0, 200))
    // The fingerprint check: a damaged or changed file is thrown away, never run.
    const h = await $.process.run(['certutil.exe', '-hashfile', winPath(part), 'SHA256'], { timeoutMs: 60000 })
    const found = String(h.stdout || '').split(/\r?\n/).map(l => l.replace(/\s+/g, '').toLowerCase()).find(l => /^[0-9a-f]{64}$/.test(l)) || ''
    if (found !== WIN_EARS.sha256) return await fail('the file did not match its fingerprint')
    const m = await $.process.run(['cmd.exe', '/c', 'move', '/y', winPath(part), winPath(dest)])
    if (m.exitCode !== 0 || !(await fileExists($, dest))) return await fail('could not save it')
    $.ui.log('Spokeline: Windows helper ' + WIN_EARS.version + ' downloaded to ' + dest)
    return true
  } catch (err) {
    return await fail(errText(err))
  }
}

async function makeDirs($, dirs) {
  for (const d of dirs) {
    try {
      if (isWin) await $.process.run([earsProgram(), '--mkdir', d])
      else await $.process.run(['/bin/mkdir', '-p', d])
    } catch { /* exists */ }
  }
}


// ---------------------------------------------------------------- inbox

// The bottom status line: a short message (speaking, downloading, say yes or no) when there is one,
// otherwise what the microphone is doing now, shown all the time.
let overlay = undefined
let micText = undefined
let shownStatus = null
let lastMicRead = 0
let micLive = null           // the unfinished words file as last read
let voiceHistory = []        // your last questions by voice, oldest first (the rows under the microphone line)
let micBars = 0              // 0 to 3 lit bars next to the microphone sign: how loud you speak now
let earsInfo = null         // ~/.spokeline/ears.json as last read
let menuOpen = false

function setStatus($, text) {
  overlay = text
  showStatus($)
}

function showStatus($) {
  const t = (overlay !== undefined ? overlay : micText) + ' [' + micBars + ']'
  if (t === shownStatus) return
  shownStatus = t
  $.ui.invalidate('ui.render')
}

async function refreshMic($) {
  if (Date.now() - lastMicRead < 250) return
  lastMicRead = Date.now()
  let ears = null
  let live = null
  try { ears = JSON.parse(await $.fs.read(base + '/ears.json')) } catch { ears = null }
  if (ears && (ears.state === 'capturing' || ears.state === 'recording' || ears.state === 'listening')) {
    try { live = JSON.parse(await $.fs.read(base + '/live/' + sessionId + '.json')) } catch { live = null }
    if (live && !(Date.now() - (Number(live.ts) || 0) < 5000)) live = null
  }
  micText = micLine(ears, live, Date.now(), sessionId, mode)
  const wordsBefore = micWords(earsInfo, micLive, Date.now(), sessionId)
  micLive = live
  if (micWords(ears, live, Date.now(), sessionId) !== wordsBefore) $.ui.invalidate('ui.render')
  micBars = micLevel(ears, Date.now(), sessionId, mode)
  let changed = JSON.stringify(menuFacts(ears)) !== JSON.stringify(menuFacts(earsInfo))
  earsInfo = ears
  // The Chat row of the menu: the open chats, read about once a second while the menu is open.
  if (menuOpen && Date.now() - menuChatsAt > 1000) {
    menuChatsAt = Date.now()
    const list = (await openChats($)).map(c => [c.id, c.title, c.busy])
    if (JSON.stringify(list) !== JSON.stringify(menuChats.map(c => [c.id, c.title, c.busy]))) changed = true
    menuChats = list.map(([id, title, busy]) => ({ id, title, busy }))
  }
  showStatus($)
  if (changed && menuOpen) $.ui.invalidate('ui.render')
}
let menuChats = []
let menuChatsAt = 0

async function tick($) {
  if (!ready || ticking) return
  ticking = true
  try {
    await refreshMic($)
    if (installing) await checkInstall($)
    if (voiceFlow() || approval) await checkPermission($)
    await checkRaise($)
    let st = null
    try { st = await $.fs.stat(inboxPath()) } catch { st = null }
    if (!st) return
    const size = typeof st.size === 'number' ? st.size : -2
    if (size === lastInboxSize) return
    lastInboxSize = size
    const text = await $.fs.read(inboxPath())
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let msg = null
      try { msg = JSON.parse(line) } catch { continue }
      if (!msg || typeof msg.seq !== 'number' || msg.seq <= lastSeq) continue
      lastSeq = msg.seq
      await handle($, msg)
    }
  } catch (err) {
    $.ui.log('inbox: ' + errText(err))
  } finally {
    ticking = false
  }
}

async function handle($, msg) {
  if (msg.type === 'command' || msg.type === 'say') await markActive($)
  if (msg.type === 'command') return runCommand($, String(msg.command || ''))
  if (msg.type !== 'say') return
  const text = String(msg.text || '').trim()
  if (!text) return
  lastActive = Date.now()      // you are talking with this chat: it keeps your voice

  const cmd = parseVoiceCommand(text)
  if (cmd && (cmd !== 'yes' && cmd !== 'no' && cmd !== 'send' && cmd !== 'cancel')) return runCommand($, cmd)
  if (cmd && (approval || draftWaiting)) return runCommand($, cmd)

  // "Switch to photobook": only when the name fits an open chat, or the sentence says "chat" / "window"
  // (then it says which chats are open); anything else ("switch to the dark theme") is a request as before.
  const sw = !cmd && !approval && !draftWaiting ? switchRequest(text) : null
  if (sw) {
    const chats = await openChats($)
    if (sw.back) {
      const prev = await previousChat($, chats)
      if (prev) return switchChat($, prev, { byVoice: true, say: 'Okay, back to ' + sayableTitle(prev.title) + '.' })
      return switchFailed($, '', chats)
    }
    const chat = matchChat(sw.name, chats)
    if (chat && chat.id === sessionId) { speak($, 'We\'re already in ' + sayableTitle(chat.title) + '.'); return }
    if (chat) return switchChat($, chat, { byVoice: true })
    if (sw.saysChat) return switchFailed($, sw.name, chats)
  }

  // A bare yes, no, send or cancel is an answer, not a question: it does not push a question off the list.
  if (!cmd) voiceHistory = [...voiceHistory, text].slice(-3)
  $.ui.invalidate('ui.render')
  if (!opts.confirm_before_send && shouldSpeakFor(true)) return talk($, text)

  if (opts.confirm_before_send) {
    try { await $.prompt.fill({ text }) } catch { /* no input box (headless) */ }
    draftWaiting = true
    await heartbeat($)
    speak($, 'I heard: ' + text + '. Say send or cancel.')
    return
  }
  submitVoice($, text)
}

async function runCommand($, cmd) {
  switch (cmd) {
    case 'listen_off':
      // You said "that's all": the conversation ends and the microphone is closed until you switch it on
      // again (/spokeline menu, Listening).
      await dlog($, 'microphone off: you said "that\'s all"')
      await setListening($, 'off')
      $.ui.toast('Spokeline: microphone off. Turn it on again with /spokeline.')
      return
    case 'stop':
      if (speaking) { stopSpeaking(); return }
      if (busy && currentTurnId) {
        try { await $.turn.abort({ turnId: currentTurnId }) } catch (err) { $.ui.toast('Could not stop: ' + errText(err)) }
      }
      return
    case 'repeat':
      if (lastSpoken) speak($, lastSpoken)
      return
    case 'mute':
      muted = true; stopSpeaking(); $.ui.toast('Spokeline: muted'); await heartbeat($); return
    case 'unmute':
      muted = false; $.ui.toast('Spokeline: speaking again'); await heartbeat($); return
    case 'yes':
    case 'no':
      if (approval) { await answerPermission($, cmd); return }
      if (draftWaiting) return runCommand($, cmd === 'yes' ? 'send' : 'cancel')
      return
    case 'send': {
      if (!draftWaiting) return
      draftWaiting = false
      let text = ''
      try { text = (await $.prompt.read()).text } catch { text = '' }
      try { await $.prompt.fill({ text: '' }) } catch { /* ignore */ }
      if (text.trim()) submitVoice($, text.trim())
      await heartbeat($)
      return
    }
    case 'cancel':
      if (!draftWaiting) return
      draftWaiting = false
      try { await $.prompt.fill({ text: '' }) } catch { /* ignore */ }
      speak($, 'Cancelled.')
      await heartbeat($)
      return
    default:
      return
  }
}

async function slashCommand($, args) {
  const [word, ...rest] = args.split(/\s+/)
  const sub = (word || 'menu').toLowerCase()
  const restText = rest.join(' ').trim()
  if (!ready) {
    // Typing a command proves a person is here: try to switch on now.
    setupTries = 0
    if (!ready) await activate($)
  }
  if (!ready && sub !== 'status' && sub !== 'help') {
    return { text: 'Spokeline is off in this session: ' + notReadyReason, isTextDisplayOnly: true }
  }
  switch (sub) {
    case 'menu': {
      menuOpen = true
      lastMicRead = 0
      menuChatsAt = 0
      await refreshMic($)
      // A side window wide enough for the longest device name (the screen allows at most 45% of its width).
      const r = await $.ui.open({ id: MENU, title: 'Spokeline', focus: true, closeOnEscape: true, holdToasts: true, columns: 90 })
      if (r && r.isPlaced === false) { menuOpen = false; return { text: 'The Spokeline menu could not open here (' + (r.reason || 'no room') + '). Try /spokeline status.', isTextDisplayOnly: true } }
      return {}
    }
    case 'say':
      if (!restText) return { text: 'Usage: /spokeline say <what you would have said>', isTextDisplayOnly: true }
      submitVoice($, restText)
      return {}
    case 'stop':
    case 'repeat':
    case 'mute':
    case 'unmute':
      await runCommand($, sub)
      return {}
    case 'talk':
      // Type to the voice partner as if you had said it (it answers out loud).
      if (!restText) return { text: 'Usage: /spokeline talk <what you would have said>', isTextDisplayOnly: true }
      talk($, restText)
      return {}
    case 'helper': {
      if (!restText) return { text: 'Usage: /spokeline helper <supporting work to do in the background>', isTextDisplayOnly: true }
      const r = await startHelper($, restText)
      return { text: r === true ? 'Background helper started: ' + restText : r, isTextDisplayOnly: true }
    }
    case 'helpers':
      return { text: helpers.size ? helperSituation() : 'No background helpers.', isTextDisplayOnly: true }
    case 'here':
      await writeConfig($, { targetSessionId: sessionId })
      return { text: 'Your voice now goes to this chat.', isTextDisplayOnly: true }
    case 'voice': {
      const w = restText.toLowerCase()
      if (w === 'install') {
        if (await naturalVoiceReady($)) return { text: 'The natural voice is already installed.', isTextDisplayOnly: true }
        await requestInstall($)
        return { text: 'Downloading the natural voice (about 350 MB, once). It switches on by itself when ready.', isTextDisplayOnly: true }
      }
      if (w === 'system' || w === 'off') { voiceOverride = 'off'; return { text: 'Using the built-in macOS voice.', isTextDisplayOnly: true } }
      if (NATURAL_VOICES[w]) {
        voiceOverride = w
        speak($, 'Hi, this is ' + w + '.')
        return { text: 'Voice: ' + w + '. To keep it, set it in /config > Spokeline > Natural voice.', isTextDisplayOnly: true }
      }
      const ready = await naturalVoiceReady($)
      return {
        text: 'Natural voice: ' + (ready ? 'installed' : installing ? 'downloading' : 'not installed (run /spokeline voice install)') +
          '. Current: ' + naturalVoiceName() + '. Voices: ' + Object.keys(NATURAL_VOICES).join(', ') + ', or system.',
        isTextDisplayOnly: true,
      }
    }
    case 'listen': {
      const m = restText.toLowerCase().replace(/[-\s]/g, '')
      const map = { off: 'off', ptt: 'push_to_talk', pushtotalk: 'push_to_talk', push_to_talk: 'push_to_talk', handsfree: 'hands_free', hands_free: 'hands_free' }
      const chosen = map[m]
      if (!chosen) return { text: 'Usage: /spokeline listen off | ptt | handsfree', isTextDisplayOnly: true }
      await setListening($, chosen)
      return { text: 'Listening mode: ' + mode.replace(/_/g, ' ') + '.', isTextDisplayOnly: true }
    }
    case 'help':
    case 'status':
    default: {
      const hot = typeof opts.hotkey === 'string' && opts.hotkey ? opts.hotkey : 'ctrl+option+v'
      const lines = [
        'Spokeline ' + (ready ? 'is on' : 'is off in this session: ' + notReadyReason) + '.',
        'Listening: ' + mode.replace(/_/g, ' ') +
          (mode === 'push_to_talk' ? ' (hold ' + hot + ' and speak)' : mode === 'hands_free' ? ' (start with "' + String(opts.wake_phrase || DEFAULT_WAKE_PHRASES).split(',').map(x => x.trim()).join('" or "') + '", then your request)' : ''),
        'Speaking: ' + (muted || opts.speak_answers === false ? 'off' : opts.speak_when === 'always' ? 'every answer' : 'answers to spoken requests'),
        'Commands: /spokeline say <text> · talk <text> · helper <task> · helpers · stop · repeat · mute · unmute · here · listen off|ptt|handsfree · voice [install|<name>]',
      ]
      return { text: lines.join('\n'), isTextDisplayOnly: true }
    }
  }
}

// The voice partner: a small fast model you talk with all the time. Nothing you say goes to the main
// session (the one on the screen) until the two of you have agreed on a task and you said yes. While the
// main session works, the partner keeps talking with you, tells you what is happening, and passes on only
// a real change of course. The screen shows the main session's work; the partner only speaks.
let lastTask = ''          // the task the main session is working on (or did last)
let pendingAck = ''        // what the partner says when the main session starts on it
let draftTask = ''         // a task the partner proposed, waiting for your yes
let draftAt = 0            // when it was proposed
let convo = []             // the spoken conversation so far: { who: 'you' | 'me', text }
let convoAt = 0
let heldText = ''          // an unfinished sentence, waiting for the rest
let heldAt = 0
let talking = false        // one answer at a time
let talkQueue = []

function remember(who, text) {
  if (Date.now() - convoAt > 15 * 60000) { convo = []; draftTask = '' }   // a new conversation after 15 quiet minutes
  convoAt = Date.now()
  convo.push({ who, text: String(text).slice(0, 600) })
  if (convo.length > 24) convo = convo.slice(-24)
}

async function talk($, text, force) {
  if (talking) { talkQueue.push(text); return }
  talking = true
  try { await talkOnce($, text, force) } finally {
    talking = false
    if (talkQueue.length) talk($, talkQueue.splice(0).join(' '))
  }
}

// ---------------------------------------------------------------- background helpers
//
// Beside the one main coding chat (the one on the screen), the voice partner can start a background helper
// for supporting work: checking usage, looking at a website, researching a question. A helper is a Claude
// subagent in this session: it works on its own, its finished-notice is kept out of the main chat, and the
// partner tells you the result and remembers it for your questions. At most MAX_HELPERS run at once.
const MAX_HELPERS = 2
const HELPER_TAG = '[Spokeline helper]'
let helpers = new Map()        // agentId -> { task, label, startedAt, steps, done, result }
let draftBackground = false

// The helper list is saved, so a /reload-plugins while a helper runs does not forget it
// (otherwise its result would land in the main chat and never be spoken).
function helpersKey() { return 'helpers-' + sessionId }
async function saveHelpers($) {
  try {
    await $.store.set(helpersKey(), [...helpers.entries()].map(([id, h]) => [id, { ...h, result: String(h.result || '').slice(0, 4000) }]))
  } catch (err) { await dlog($, 'could not save the helper list: ' + errText(err)) }
}
async function loadHelpers($) {
  try {
    const saved = await $.store.get(helpersKey())
    if (Array.isArray(saved)) {
      for (const [id, h] of saved) {
        if (id && h && Date.now() - Number(h.startedAt || 0) < 6 * 3600000 && !helpers.has(id)) {
          helpers.set(id, { task: String(h.task || ''), label: String(h.label || ''), startedAt: Number(h.startedAt), steps: Array.isArray(h.steps) ? h.steps : [], done: !!h.done, result: String(h.result || '') })
          if (!h.done) $.clock.after(HELPER_STATUS_EVERY_MS, () => helperStatusTick($, id, Array.isArray(h.steps) ? h.steps.length : 0))
        }
      }
    }
    // Tidy up: lists of chats from more than a day ago.
    for (const k of (await $.store.keys()) || []) {
      if (!k.startsWith('helpers-') || k === helpersKey()) continue
      const v = await $.store.get(k)
      const newest = Array.isArray(v) ? Math.max(0, ...v.map(x => Number((x[1] || {}).startedAt) || 0)) : 0
      if (Date.now() - newest > 24 * 3600000) await $.store.delete(k)
    }
  } catch (err) { await dlog($, 'could not read the helper list: ' + errText(err)) }
}

function isHelperNotice(text) {
  if (text.includes(HELPER_TAG)) return true
  for (const id of helpers.keys()) if (id && text.includes(id)) return true
  return false
}

async function startHelper($, task) {
  const running = [...helpers.values()].filter(h => !h.done)
  if (running.length >= MAX_HELPERS) return 'I already have ' + running.length + ' background checks running. Let\'s wait for one to finish first.'
  const label = task.replace(/\s+/g, ' ').slice(0, 50)
  try {
    const r = await $.agent.spawn({
      prompt: task + '\n\nYou are a background helper: the developer is busy with other work and will hear a short ' +
        'spoken summary of your answer. Do the research or checks needed, change no files unless the task says so, ' +
        'and end with a short, plain answer: what you found, with the key numbers or facts.',
      description: HELPER_TAG + ' ' + label,
      subagentType: 'general-purpose',
    })
    if (!r || r.deny || !r.agentId) {
      await dlog($, 'helper not started: ' + JSON.stringify(r))
      return 'I could not start a background helper' + (r && r.deny ? ': ' + String(r.deny).slice(0, 120) : '.')
    }
    helpers.set(r.agentId, { task, label, startedAt: Date.now(), steps: [], done: false, result: '' })
    await saveHelpers($)
    $.ui.invalidate('ui.render')
    $.clock.after(HELPER_STATUS_EVERY_MS, () => helperStatusTick($, r.agentId, 0))
    await dlog($, 'helper started ' + r.agentId + ': ' + task)
    return true
  } catch (err) {
    await dlog($, 'helper failed to start: ' + errText(err))
    return 'I could not start a background helper.'
  }
}

async function helperFinished($, e) {
  const h = helpers.get(e.agentId)
  if (!h || h.done) return
  h.done = true
  $.ui.invalidate('ui.render')
  h.result = String(e.answer || '').trim() || (e.isAborted ? '(stopped before it finished)' : '(no answer)')
  await dlog($, 'helper finished ' + e.agentId + ' chars=' + h.result.length)
  // Forget finished helpers after a while, keep the newest few.
  const finished = [...helpers.entries()].filter(([, x]) => x.done)
  for (const [id] of finished.slice(0, Math.max(0, finished.length - 4))) helpers.delete(id)
  await saveHelpers($)
  let spoken = ''
  try {
    const r = await $.model.complete({
      model: 'haiku', system: SUMMARY_SYSTEM,
      prompt: 'The background check "' + h.label + '" finished. Its answer:\n' + h.result.slice(0, 12000),
      maxTokens: 220, timeoutMs: 8000,
    })
    if (r && r.isAnswered && r.text) spoken = r.text.trim()
  } catch { /* use the plain version */ }
  if (!spoken) spoken = cleanForSpeech(h.result)
  const line = 'The background check is done. ' + spoken
  remember('me', '(background helper finished: ' + h.label + ') ' + spoken)
  announce($, line, Date.now())
}

// Say it when nothing else is being said (never cut off an answer), giving up after two minutes.
function announce($, line, since) {
  if (muted || !shouldSpeakFor(true)) return
  if (speaking || talking) {
    if (Date.now() - since < 120000) $.clock.after(1500, () => announce($, line, since))
    return
  }
  speak($, line)
}

function helperSituation() {
  if (!helpers.size) return 'No background helpers.'
  const rows = []
  for (const h of helpers.values()) {
    rows.push(h.done
      ? 'Background helper finished: "' + h.label + '". Its answer: ' + h.result.replace(/\s+/g, ' ').slice(0, 1500)
      : 'Background helper running for ' + Math.round((Date.now() - h.startedAt) / 1000) + ' s: "' + h.label + '". Latest steps: ' + (h.steps.slice(-4).join('; ') || 'starting'))
  }
  return rows.join('\n')
}

// What the coding chat on screen said and did lately, so the partner can answer from it without a new task.
async function chatHistory($) {
  try {
    const msgs = await $.session.messages({ last: 40 })
    if (!Array.isArray(msgs)) return ''
    const parts = []
    for (const m of msgs) {
      const t = String(m.text || '').replace(/\s+/g, ' ').trim()
      const tools = Array.isArray(m.toolUses) && m.toolUses.length ? ' [used: ' + m.toolUses.map(u => u.name || u.tool || 'tool').slice(0, 5).join(', ') + ']' : ''
      if (!t && !tools) continue
      parts.push((m.role === 'user' ? 'Developer (typed or sent): ' : 'Coding chat: ') + (t.length > 2500 ? t.slice(0, 2500) + '…' : t) + tools)
    }
    let out = parts.join('\n')
    if (out.length > 30000) out = '…' + out.slice(-30000)   // keep the newest part
    return out
  } catch (err) { await dlog($, 'could not read the chat: ' + errText(err)); return '' }
}

async function talkOnce($, text, force) {
  if (heldText && Date.now() - heldAt < 20000) text = heldText + ' ' + text
  heldText = ''
  if (draftTask && Date.now() - draftAt > 10 * 60000) { draftTask = ''; draftBackground = false }   // a proposal nobody answered for 10 minutes is dropped
  const working = busy && !!currentTurnId
  const recent = activity.slice(-6)
  const history = await chatHistory($)
  const chats = await openChats($)
  // Each name once (one folder can have several chats), and not this chat's own name.
  const myTitle = basename(cwd || '') || 'Claude'
  const otherNames = [...new Set(chats.filter(c => c.id !== sessionId && c.title.toLowerCase() !== myTitle.toLowerCase()).map(c => c.title))]
  const prev = await previousChat($, chats)
  const lines = [
    'Project folder: ' + basename(cwd || '') + ' (this chat).',
    otherNames.length
      ? 'Other open chats the developer can switch to: ' + otherNames.join(', ') + '.'
      : 'No other chats are open.',
    ...(prev ? ['The developer\'s voice was switched here from the chat "' + prev.title + '": going back means that one.'] : []),
    history ? 'Recent history of the coding chat on screen (newest last):\n' + history : 'The coding chat has no history yet.',
    '',
    working
      ? 'The main session is working on this task: "' + lastTask + '". Its latest steps: ' + (recent.length ? recent.join('; ') : 'just started') + '.'
      : 'The main session is not working.' + (lastTask ? ' Its last task was: "' + lastTask + '".' : ''),
    draftTask ? 'You proposed this task' + (draftBackground ? ' (as a background helper)' : '') + ' and are waiting for a yes: "' + draftTask + '".' : 'No task is waiting for a yes.',
    helperSituation(),
    '',
    'The conversation so far:',
    ...(convo.length ? convo.map(c => (c.who === 'you' ? 'Developer: ' : 'You: ') + c.text) : ['(nothing yet)']),
    '',
    'The developer just said: "' + text + '"',
    ...(force ? ['The developer has stopped and said nothing more for a while: treat this as finished, and do not answer "wait".'] : []),
  ]
  let reply = null
  let unreachable = false
  // Anthropic's servers sometimes answer "overloaded" (HTTP 529) for the small model: on 24.11.2026 that
  // happened twice in a row, and each time you heard "Sorry, I didn't catch that". Now a failed call is
  // tried once more, with the bigger model, which is served separately.
  for (const model of ['haiku', 'sonnet']) {
    unreachable = false
    try {
      const r = await $.model.complete({
        model,
        system: PARTNER_SYSTEM,
        prompt: lines.join('\n'),
        maxTokens: 1500,          // a long request becomes a long task: room enough that the answer is never cut off
        timeoutMs: 15000,
      })
      if (r && r.isAnswered && r.text) {
        reply = parseTalk(r.text) || plainTalk(r.text)
        if (!reply) await dlog($, 'partner answer not readable: ' + JSON.stringify(String(r.text).slice(0, 400)))
        else if (!parseTalk(r.text)) await dlog($, 'partner answered in plain words, said as they are')
        break
      }
      unreachable = !!r && r.reason === 'api-error'
      await dlog($, 'partner (' + model + ') gave no answer: ' + (r && r.reason) + (r && r.status ? ' ' + r.status : ''))
    } catch (err) {
      unreachable = true
      await dlog($, 'partner (' + model + ') failed: ' + errText(err))
    }
    if (!unreachable) break
  }
  if (!reply) {
    // Never lose what you said: a long request goes to the coding chat as it was heard.
    remember('you', text)
    if (text.split(/\s+/).length >= 25 && !working) {
      lastTask = text
      pendingAck = 'I had trouble with that, so I passed your words on as they were.'
      submitVoice($, text)
      return
    }
    speak($, unreachable
      ? 'Sorry, I can\'t reach the voice assistant right now; Anthropic\'s servers are busy. Please say it again in a moment.'
      : 'Sorry, I didn\'t catch that. Could you say it again?')
    return
  }
  await dlog($, 'partner: ' + reply.action + ' ' + JSON.stringify(reply.say) + (reply.task ? ' task=' + JSON.stringify(reply.task) : '') + ' for ' + JSON.stringify(text))

  // Cut off in the middle of a sentence (a pause to think): wait for the rest, then answer the whole.
  if (reply.action === 'wait' && !force) {
    heldText = text
    heldAt = Date.now()
    const mine = heldAt
    $.clock.after(12000, () => { if (heldText && heldAt === mine) { const t = heldText; heldText = ''; talk($, t, true) } })
    return
  }
  // You asked it to stop listening in your own words ("say it, that's all"): it says goodbye and closes the
  // microphone (before, it said "I'll stop listening" and went on listening).
  // A reply that tells you the microphone is off must really switch it off.
  if (reply.action === 'talk' && /\bmicrophone (?:is )?off\b|\bstop(?:ping)? listening now\b/i.test(reply.say)) reply.action = 'off'
  if (reply.action === 'off') {
    remember('you', text)
    const bye = reply.say || 'Okay, microphone off.'
    remember('me', bye)
    speak($, bye)
    await runCommand($, 'listen_off')
    return
  }
  // Waited already and still "wait" with nothing to say: you got no answer at all (23.11.2026). Say something.
  if (reply.action === 'wait' || (reply.action === 'talk' && !reply.say)) {
    reply.action = 'talk'
    if (!reply.say) reply.say = 'I heard you. What would you like me to do with that?'
  }
  remember('you', text)
  if (reply.say) remember('me', reply.say)
  lastPromptByVoice = true

  // "Let's work on NoteKeeper now": your voice goes to that chat, and its VS Code window comes to the front.
  if (reply.action === 'switch') {
    const chat = matchChat(reply.chat, chats)
    if (chat && chat.id === sessionId) { speak($, 'We\'re already in ' + sayableTitle(chat.title) + '.'); return }
    if (chat) return switchChat($, chat, { byVoice: true, say: reply.say })
    return switchFailed($, reply.chat, chats)
  }

  if (reply.action === 'propose' && reply.task) { draftTask = reply.task; draftBackground = reply.background; draftAt = Date.now() }
  // Background helper: supporting work beside the main chat (the main chat is not touched).
  if (reply.action === 'start' && (reply.background || (draftBackground && !reply.task)) && (reply.task || draftTask)) {
    const task = reply.task || draftTask
    draftTask = ''
    draftBackground = false
    const said = await startHelper($, task)
    speak($, said === true ? (reply.say || 'Okay, I\'ll look into that in the background.') : said)
    if (said !== true) remember('me', said)
    return
  }
  if (reply.action === 'start' && (reply.task || draftTask) && !working) {
    const task = reply.task || draftTask
    draftTask = ''
    draftBackground = false
    lastTask = task
    pendingAck = reply.say
    submitVoice($, task)        // the main session starts; the acknowledgement is spoken when it does
    return
  }
  if ((reply.action === 'change' || reply.action === 'start') && working && (reply.task || text)) {
    pendingNotes.push(reply.task || text)
    draftTask = ''
  }
  if (reply.say) speak($, reply.say)
}

function shouldSpeakFor(byVoice) {
  return !muted && opts.speak_answers !== false && (opts.speak_when === 'always' || byVoice)
}

function submitVoice($, text) {
  lastPromptByVoice = true
  lastVoiceText = text
  lastTask = text.slice(0, 500)
  lastActive = Date.now()
  const sent = 'sent: ' + (text.length > 80 ? text.slice(0, 80) + '…' : text)
  setStatus($, sent)
  $.clock.after(4000, () => { if (overlay === sent) setStatus($, undefined) })
  $.prompt.submit({ text, asUser: true }).then(
    r => { if (r && r.drop) $.ui.toast('Spokeline: not sent (' + r.drop + ')') },
    err => { $.ui.toast('Spokeline: not sent (' + errText(err) + ')') },
  )
}

// ---------------------------------------------------------------- speaking

// While Claude works on a spoken request, say right away that it was heard ("Okay, checking the log."),
// and once more if it takes long, so you are never left in silence wondering.
async function acknowledge($, turnId) {
  const said = lastVoiceText
  lastVoiceText = ''
  const stillWaiting = () => busy && currentTurnId === turnId && !speaking && !muted
  let ack = pendingAck
  pendingAck = ''
  if (!ack) try {
    const r = await $.model.complete({
      model: 'haiku',
      system: ACK_SYSTEM,
      prompt: said.length > 2000 ? said.slice(0, 2000) : said,
      maxTokens: 40,
      timeoutMs: 2500,
    })
    if (r && r.isAnswered && r.text && r.text.trim()) ack = r.text.trim()
  } catch (err) { await dlog($, 'acknowledge failed: ' + errText(err)) }
  if (!ack) ack = 'Okay, one moment.'
  if (!stillWaiting()) return
  await dlog($, 'acknowledge: ' + JSON.stringify(ack))
  await speak($, ack)
}

// Every 20 s while Claude works on a spoken request: one short spoken line about what it is doing now.
const STATUS_EVERY_MS = 20000
async function statusTick($, turnId, lastSaid) {
  if (!busy || currentTurnId !== turnId || muted || !shouldSpeak()) return
  const again = () => $.clock.after(STATUS_EVERY_MS, () => statusTick($, turnId, lastSaid))
  if (speaking) { again(); return }
  const fresh = activity.slice(activitySeen)
  let line = ''
  if (fresh.length) {
    activitySeen = activity.length
    try {
      const r = await $.model.complete({
        model: 'haiku',
        system: STATUS_SYSTEM,
        prompt: fresh.join('\n'),
        maxTokens: 40,
        timeoutMs: 2500,
      })
      if (r && r.isAnswered && r.text && r.text.trim()) line = r.text.trim()
    } catch (err) { await dlog($, 'status failed: ' + errText(err)) }
    if (!line) line = 'Now I ' + fresh[fresh.length - 1] + '.'
  } else if (Date.now() - lastSaid > 45000) {
    line = 'Still working on it.'
  }
  if (line && busy && currentTurnId === turnId && !speaking) {
    lastSaid = Date.now()
    await dlog($, 'status: ' + JSON.stringify(line))
    remember('me', line)
    await speak($, line)
  }
  again()
}

async function speakAnswer($, answer) {
  const text = String(answer || '').trim()
  if (!text) return
  let spoken = ''
  if (isShortPlain(text)) {
    spoken = text
  } else if (opts.summary !== 'simple') {
    try {
      const r = await $.model.complete({
        model: 'haiku',
        system: SUMMARY_SYSTEM,
        prompt: text.length > 12000 ? text.slice(0, 12000) : text,
        maxTokens: 200,
        timeoutMs: 5000, // don't keep the person waiting: after 5 s use the simple version
      })
      if (r && r.isAnswered && r.text && r.text.trim()) spoken = r.text.trim()
      else await dlog($, 'summary model gave no answer: ' + (r && r.reason))
    } catch (err) { await dlog($, 'summary model failed: ' + errText(err)) }
  }
  if (!spoken) spoken = cleanForSpeech(text)
  await dlog($, 'speakAnswer: spoken=' + JSON.stringify(spoken.slice(0, 160)))
  if (spoken) remember('me', '(the main session finished) ' + spoken)
  if (spoken) await speak($, spoken)
}

async function speak($, text) {
  if (muted || !text) return
  lastSpoken = text
  stopSpeaking()
  const ctl = new AbortController()
  speakAbort = ctl
  speaking = true
  await heartbeat($)          // Ears pauses the microphone while this is true
  // No words while it speaks: the microphone line stays as it is and a speaker sign appears beside it.
  $.ui.invalidate('ui.render')
  try {
    let done = false
    if (naturalVoiceName() !== 'off' && (await naturalVoiceReady($))) {
      done = await speakNatural($, text, ctl)
    } else if (naturalVoiceName() !== 'off') {
      offerNaturalVoice($)
    }
    if (!done && !ctl.signal.aborted && isWin) {
      const stop = base + '/voice/tmp/system-stop-' + Date.now()
      killPlayer = () => { $.fs.write(stop, '1').catch(() => {}) }
      await $.process.run([earsProgram(), '--say-system', text, '--stop-file', stop], { timeoutMs: 180000 })
      done = true
    }
    if (!done && !ctl.signal.aborted) {
      const voice = typeof opts.voice === 'string' && opts.voice ? opts.voice : bestVoice
      if (voice) await $.audio.speak(text, { voice, signal: ctl.signal })
      else await $.audio.speak(text, { signal: ctl.signal })
    }
  } catch (err) {
    await dlog($, 'speak error: ' + errText(err) + ' aborted=' + ctl.signal.aborted)
    if (!ctl.signal.aborted) $.ui.log('could not speak: ' + errText(err))
  } finally {
    await dlog($, 'speak end aborted=' + ctl.signal.aborted)
    if (speakAbort === ctl) {
      speakAbort = null
      speaking = false
      $.ui.invalidate('ui.render')
      await heartbeat($)
    }
  }
}

function stopSpeaking() {
  if (speakAbort || killPlayer) logLines.push(new Date().toISOString() + ' stopSpeaking called')
  if (speakAbort) {
    try { speakAbort.abort('stopped') } catch { /* ignore */ }
    speakAbort = null
  }
  if (killPlayer) { try { killPlayer() } catch { /* ignore */ } killPlayer = null }
  speaking = false
}

// ---------------------------------------------------------------- natural voice (Kokoro, on this Mac)
//
// The Ears helper downloads the open-source sherpa-onnx engine and the Kokoro voice into ~/.spokeline/voice
// once, after the person agrees. We run the engine per sentence (the first sentence plays while the next
// is being made) and play the result with macOS's afplay.

let pluginRoot = ''
let voiceOverride = ''
let voiceOffered = false
let installing = false
let killPlayer = null
let wavCounter = 0

function naturalVoiceName() {
  if (voiceOverride) return voiceOverride
  return typeof opts.natural_voice === 'string' && opts.natural_voice ? opts.natural_voice : 'heart'
}

async function naturalVoiceReady($) {
  try {
    if (isWin) return await $.fs.exists(base + '/voice/kokoro/model.onnx')
    return (await $.fs.exists(base + '/voice/engine/bin/sherpa-onnx-offline-tts')) && (await $.fs.exists(base + '/voice/kokoro/model.onnx'))
  } catch { return false }
}

async function speakNatural($, text, ctl) {
  const voice = NATURAL_VOICES[naturalVoiceName()] || NATURAL_VOICES.heart
  const kokoro = base + '/voice/kokoro'
  const lexicons = [kokoro + (voice.accent === 'gb' ? '/lexicon-gb-en.txt' : '/lexicon-us-en.txt')]
  if (pluginRoot) lexicons.push(pluginRoot + '/voice/extra-lexicon.txt')
  const tmp = base + '/voice/tmp'
  await makeDirs($, [tmp])
  const tag = 'spokeline-say-' + sessionId

  const make = async (sentence) => {
    const wav = tmp + '/' + tag + '-' + (wavCounter++) + '.wav'
    const args = (s) => isWin ? [
      earsProgram(), '--say', s, '--voice', naturalVoiceName(), '--out', wav,
      '--lexicon', pluginRoot ? pluginRoot + '/voice/extra-lexicon.txt' : '',
    ] : [
      base + '/voice/engine/bin/sherpa-onnx-offline-tts',
      '--kokoro-model=' + kokoro + '/model.onnx',
      '--kokoro-voices=' + kokoro + '/voices.bin',
      '--kokoro-tokens=' + kokoro + '/tokens.txt',
      '--kokoro-lexicon=' + lexicons.join(','),
      '--sid=' + voice.sid,
      '--num-threads=4',
      '--output-filename=' + wav,
      s,
    ]
    let r = await $.process.run(args(sentence), { timeoutMs: 60000 })
    await dlog($, 'synth exit=' + r.exitCode + ' chars=' + sentence.length + (r.exitCode !== 0 ? ' err=' + String(r.stderr || '').slice(-300) : ''))
    const unknown = parseUnknownWords((r.stderr || '') + (r.stdout || ''))
    if (unknown.length) {
      const fixed = fixUnknownWords(sentence, unknown)
      if (fixed && fixed !== sentence) r = await $.process.run(args(fixed), { timeoutMs: 60000 })
    }
    return r.exitCode === 0 ? wav : ''
  }

  const sentences = splitSentences(prepareForVoice(text))
  if (sentences.length === 0) return true
  const stopFile = tmp + '/' + tag + '-stop-' + Date.now()
  killPlayer = isWin
    ? () => { $.fs.write(stopFile, '1').catch(() => {}) }
    : () => { $.process.run(['/usr/bin/pkill', '-f', tag]).catch(() => {}) }
  let next = make(sentences[0])
  for (let i = 0; i < sentences.length; i++) {
    const wav = await next
    if (ctl.signal.aborted) return true
    if (!wav) return i > 0          // the first sentence failed: let the system voice say it
    next = i + 1 < sentences.length ? make(sentences[i + 1]) : null
    try {
      // Ears plays on the speakers chosen in the /spokeline menu (on a Mac too; the file name carries `tag`,
      // so the pkill above still stops it). If Ears cannot play it on a Mac: afplay, on the Mac default.
      let p = await $.process.run([earsProgram(), '--play', wav, '--stop-file', stopFile], { timeoutMs: 180000 })
      if (!isWin && p.exitCode !== 0 && !ctl.signal.aborted) p = await $.process.run(['/usr/bin/afplay', wav], { timeoutMs: 180000 })
      await dlog($, 'play exit=' + p.exitCode + (p.exitCode !== 0 ? ' err=' + String(p.stderr || '').slice(-200) : ''))
    } catch (err) { await dlog($, 'play failed: ' + errText(err)) }
    if (isWin) $.process.run([earsProgram(), '--delete', wav]).catch(() => {})
    else $.process.run(['/bin/rm', '-f', wav]).catch(() => {})
    if (ctl.signal.aborted) return true
  }
  return true
}

/** Once per session: offer to download the natural voice. */
function offerNaturalVoice($) {
  if (voiceOffered || installing) return
  voiceOffered = true
  askToInstall($)
}

async function askToInstall($) {
  try {
    if ((await $.store.get('naturalVoiceOffer')) === 'declined') return
  } catch { /* no store: ask anyway */ }
  let answer = ''
  try {
    answer = await $.ui.ask(
      isWin
        ? 'Spokeline needs its speech pack to hear you and to speak with a natural voice: free, open-source models ' +
          'that run on this PC (about 600 MB, downloaded once from GitHub). Download it?'
        : 'Spokeline can speak with a natural, human-sounding voice instead of the robotic one. ' +
          'It is a free open-source voice that runs on this Mac (about 350 MB, downloaded once from GitHub). Download it?',
      ['Download', 'Not now', 'Never ask again'],
    )
  } catch {
    $.ui.toast('Spokeline: for a natural voice, run /spokeline voice install (about 350 MB, once).')
    return
  }
  if (answer === 'Download') await requestInstall($)
  else if (answer === 'Never ask again') { try { await $.store.set('naturalVoiceOffer', 'declined') } catch { /* ignore */ } }
}

async function requestInstall($) {
  await makeDirs($, [base + '/voice'])
  await $.fs.write(base + '/voice/install.request', String(Date.now()))
  installing = true
  await startEars($)
  $.ui.toast('Spokeline: downloading the natural voice in the background…')
}

async function checkInstall($) {
  if (!installing) return
  let st = null
  try { st = JSON.parse(await $.fs.read(base + '/voice/status.json')) } catch { return }
  if (!st) return
  if (st.state === 'ready') {
    installing = false
    setStatus($, undefined)
    $.ui.toast('Spokeline: the natural voice is ready.')
    speak($, 'Hi. This is my new voice. I hope it sounds much better.')
  } else if (st.state === 'error') {
    installing = false
    setStatus($, undefined)
    $.ui.toast('Spokeline: the voice download failed: ' + (st.error || 'unknown error') + '. Try /spokeline voice install again.')
  } else {
    setStatus($, 'downloading the natural voice: ' + Math.round((st.progress || 0) * 100) + '%')
  }
}

// ---------------------------------------------------------------- spoken approvals
//
// "Approve by voice" (setting voice_approvals, off unless the person switches it on). Claude Code runs the
// plugin's PermissionRequest hook (hooks/permission-hook.sh on the Mac, hooks/permission-hook.mjs on Windows)
// only when a permission box would really be shown to the person. While you are talking by voice, that hook writes the request to
// ~/.spokeline/permission/<chat id>.json and waits a few seconds for your spoken yes or no, which we write
// to ~/.spokeline/permission/<chat id>.answer. No answer: the normal box appears.

let lastPermissionId = ''

function permissionPath() { return base + '/permission/' + sessionId + '.json' }
function answerPath() { return base + '/permission/' + sessionId + '.answer' }

function voiceFlow() {
  return lastPromptByVoice && !muted && mode !== 'off' && opts.voice_approvals === true && opts.speak_answers !== false
}

async function checkPermission($) {
  let req = null
  try {
    if (!(await $.fs.exists(permissionPath()))) return
    req = JSON.parse(await $.fs.read(permissionPath()))
  } catch { return }
  if (approval && req && req.id === approval.id && req.state !== 'waiting') {
    // The hook stopped waiting (timed out): the normal permission box is showing now.
    approval = null
    setStatus($, undefined)
    await heartbeat($)
    return
  }
  if (!req || !req.id || req.id === lastPermissionId || req.state !== 'waiting') return
  lastPermissionId = req.id
  approval = { answer: null, id: req.id }
  await heartbeat($)
  const what = describeTool(req.tool, req.input)
  await speak($, 'Claude wants to ' + what + '. Say yes or no.')
  setStatus($, 'say yes or no… (or answer in the permission box)')
}

async function answerPermission($, answer) {
  if (!approval) return
  const id = approval.id
  approval = null
  setStatus($, undefined)
  try { await $.fs.write(answerPath(), JSON.stringify({ id, answer })) } catch (err) { $.ui.log('answer not saved: ' + errText(err)) }
  await heartbeat($)
}

// A small log file per chat (~/.spokeline/log-<chat>.txt) for fixing problems: last 300 lines.
let logLines = []
let logWriting = false
async function dlog($, msg) {
  if (!base || !sessionId) return
  logLines.push(new Date().toISOString() + ' ' + msg)
  if (logLines.length > 300) logLines = logLines.slice(-300)
  if (logWriting) return
  logWriting = true
  try { await $.fs.write(base + '/log-' + sessionId.slice(0, 8) + '.txt', logLines.join('\n') + '\n') } catch { /* ignore */ }
  logWriting = false
}

function errText(err) {
  if (!err) return 'unknown error'
  return String(err.message || err)
}


// ---------------------------------------------------------------- the /spokeline menu

const MENU = 'spokeline-menu'
const DEFAULT_DEVICE = '(default)'

/// What the menu shows from the state file: only these redraw the menu when they change.
function menuFacts(ears) {
  if (!ears) return null
  return [ears.mode, ears.target, ears.microphone, ears.speakers, ears.defaultMicrophone, ears.defaultSpeakers,
    (ears.microphones || []).join('|'), (ears.speakersList || []).join('|')]
}

async function setListening($, chosen) {
  mode = chosen
  if (mode !== 'off') { activeMarkedAt = Date.now(); await writeConfig($, { activeAt: activeMarkedAt }) }
  else await writeConfig($, {})
  if (mode !== 'off') await startEars($)
  lastMicRead = 0
  await refreshMic($)
  if (menuOpen) $.ui.invalidate('ui.render')
}

// A device just chosen in the menu, until the Ears helper reports it in use (it takes about a second): a second
// Enter in that time moves on from the new choice instead of picking the same device again.
const pendingDevice = { microphone: null, speakers: null, chat: null }
function chosenDevice(kind, reported) {
  const want = pendingDevice[kind]
  if (want === null) return reported || ''
  if ((reported || '') === want) { pendingDevice[kind] = null; return want }
  return want
}

function deviceOptions(list, chosen, def) {
  const names = Array.isArray(list) ? list.filter(n => typeof n === 'string' && n && n !== DEFAULT_DEVICE) : []
  const opts = [{ value: DEFAULT_DEVICE, label: (isWin ? 'Windows' : 'Mac') + ' default' + (def ? ' (' + def + ')' : '') }]
  for (const n of names) opts.push({ value: n, label: n })
  // A chosen device that is unplugged now still shows, so the row says what is set.
  if (chosen && !names.includes(chosen)) opts.push({ value: chosen, label: chosen + ' (not connected)' })
  return opts
}

/// The menu: one row per setting. Tab (and in the terminal the arrow keys) moves between rows, Enter changes the
/// row to its next choice (a Select took the arrow keys for itself, so you could not move past the first row),
/// Esc closes. Each row also has a fixed number key (1 Listening, 2 Speak answers, 3 Voice, 4 Microphone,
/// 5 Speakers, 6 Chat, 7 Switch off after), the same number even when a row above it is missing.
/// The VS Code panel (2.1.331) moves between rows only with Tab: it does nothing with the arrow keys there,
/// and it does not pass number keys on to a menu row either, so the hint at the bottom says so.
function menuRows($, { Text, Button }, surface) {
  const ears = earsInfo
  const key = (ears && ears.hotkey) || (typeof opts.hotkey === 'string' && opts.hotkey) || 'the key'
  const wake = (ears && ears.wake) || String(opts.wake_phrase || 'claude').split(',')[0].trim()
  const after = (list, value) => list[(Math.max(0, list.findIndex(o => o.value === value)) + 1) % list.length]
  const labelOf = (list, value) => (list.find(o => o.value === value) || list[0]).label
  const rows = [h(Text, { bold: true }, '🎙 ' + (micText || 'Spokeline')), h(Text, {}, ' ')]
  let first = true
  let lastKey = '1'
  const row = (name, hotkey, list, value, choose) => {
    // Only the first row carries autoFocus at all: `autoFocus: false` is refused and the menu was not drawn.
    rows.push(h(Button, { key: 'menu-' + name, plain: true, hotkey, ...(first ? { autoFocus: true } : {}), label: name + ': ' + labelOf(list, value),
      onPress: async () => { await choose(after(list, value).value); $.ui.invalidate('ui.render') } }))
    first = false
    lastKey = hotkey
  }
  row('Listening', '1', [
    { value: 'hands_free', label: 'hands free (say "' + wake + '", then your request)' },
    { value: 'push_to_talk', label: 'push to talk (hold ' + key + ')' },
    { value: 'off', label: 'off (microphone closed)' },
  ], mode, (v) => setListening($, v))
  row('Speak answers', '2', [{ value: 'on', label: 'on' }, { value: 'off', label: 'off' }], muted ? 'off' : 'on',
    (v) => runCommand($, v === 'off' ? 'mute' : 'unmute'))
  const voices = [...Object.keys(NATURAL_VOICES).map(v => ({ value: v, label: v })), { value: 'off', label: 'built-in voice' }]
  const current = naturalVoiceName()
  row('Voice', '3', voices, voices.some(v => v.value === current) ? current : 'off', (v) => {
    voiceOverride = v
    speak($, v === 'off' ? 'This is the built-in voice.' : 'Hi, this is ' + v + '.')
  })
  if (ears && Array.isArray(ears.microphones)) {
    const mic = chosenDevice('microphone', ears.microphone)
    row('Microphone', '4', deviceOptions(ears.microphones, mic, ears.defaultMicrophone), mic || DEFAULT_DEVICE,
      async (v) => { pendingDevice.microphone = v === DEFAULT_DEVICE ? '' : v; await writeConfig($, { microphone: pendingDevice.microphone }); lastMicRead = 0 })
  }
  if (ears && Array.isArray(ears.speakersList)) {
    const spk = chosenDevice('speakers', ears.speakers)
    row('Speakers', '5', deviceOptions(ears.speakersList, spk, ears.defaultSpeakers), spk || DEFAULT_DEVICE,
      async (v) => { pendingDevice.speakers = v === DEFAULT_DEVICE ? '' : v; await writeConfig($, { speakers: pendingDevice.speakers }); lastMicRead = 0 })
  }
  // The chat your voice goes to: Enter moves it to the next open chat (no window is brought forward here,
  // or each Enter would take you away from this menu).
  if (menuChats.length > 1) {
    const target = chosenDevice('chat', ears && ears.target) || sessionId
    const chats = menuChats.map(c => ({ value: c.id, label: c.title + (c.id === sessionId ? ' (this chat)' : '') + (c.busy ? ' (working)' : '') }))
    row('Chat', '6', chats, target, async (v) => {
      pendingDevice.chat = v
      const c = menuChats.find(x => x.id === v)
      if (c) await switchChat($, c, { byVoice: false })
    })
  }
  // How long the microphone may stay on with nobody using the voice (shared by all chats).
  row('Switch off after', '7', IDLE_OFF_CHOICES.map(m => ({ value: m, label: idleOffLabel(m) })), idleOff,
    async (v) => { idleOff = v; activeMarkedAt = Date.now(); await writeConfig($, { idleOffMinutes: v, activeAt: activeMarkedAt }) })
  if (ears && ears.target && ears.target !== sessionId) {
    rows.push(h(Button, { key: 'menu-here', plain: true, label: 'Send my voice to this chat',
      onPress: async () => { pendingDevice.chat = sessionId; await writeConfig($, { targetSessionId: sessionId }); lastMicRead = 0; $.ui.invalidate('ui.render') } }))
  }
  rows.push(h(Text, {}, ' '), h(Text, { dimColor: true }, surface === 'vscode'
    ? 'Tab: move · Enter: change · Esc: close'
    : 'Arrows: move · Enter or 1-' + lastKey + ': change · Esc: close'))
  return rows
}


// While a background check runs: its row above the prompt counts the time every few seconds, and every
// 30 s one short spoken line says what it is doing (only when nothing else is being said).
const HELPER_STATUS_EVERY_MS = 30000
let helperClock = false
function keepHelperRowsFresh($) {
  if (helperClock) return
  helperClock = true
  $.clock.every(5000, () => { if ([...helpers.values()].some(x => !x.done)) $.ui.invalidate('ui.render') })
}

async function helperStatusTick($, id, seen) {
  const x = helpers.get(id)
  if (!x || x.done) return
  const again = (n) => $.clock.after(HELPER_STATUS_EVERY_MS, () => helperStatusTick($, id, n))
  if (muted || !shouldSpeakFor(true) || speaking || talking) { again(seen); return }
  const fresh = x.steps.slice(Math.min(seen, x.steps.length))
  let line = ''
  if (fresh.length) {
    try {
      const r = await $.model.complete({
        model: 'haiku', system: HELPER_STATUS_SYSTEM,
        prompt: 'The background check is about: ' + x.label + '\nLatest steps:\n' + fresh.join('\n'),
        maxTokens: 40, timeoutMs: 2500,
      })
      if (r && r.isAnswered && r.text && r.text.trim()) line = r.text.trim()
    } catch (err) { await dlog($, 'helper status failed: ' + errText(err)) }
    if (!line) line = 'The background check is now going to ' + fresh[fresh.length - 1] + '.'
  } else {
    line = 'The background check is still working.'
  }
  if (!x.done && !speaking && !talking) {
    await dlog($, 'helper status: ' + JSON.stringify(line))
    remember('me', line)
    await speak($, line)
  }
  again(x.steps.length)
}
