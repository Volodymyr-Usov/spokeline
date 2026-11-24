// Pure text helpers: no mods API calls here, so they are easy to test.

/** Last part of a path: "/a/b/c.ts" -> "c.ts". */
export function basename(path) {
  if (typeof path !== 'string' || path === '') return ''
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** True when the text is short and has nothing that sounds bad when read aloud. */
export function isShortPlain(text) {
  if (typeof text !== 'string') return false
  if (text.length > 220) return false
  return !/```|`|\|.*\||https?:\/\/|^\s*[-*#>]|\n\s*\n/m.test(text)
}

/**
 * Turn a Markdown answer into a few plain sentences that sound fine when spoken:
 * drop code blocks, tables, links, headings and paths; keep the first sentences.
 */
export function cleanForSpeech(markdown, maxSentences = 3, maxChars = 400) {
  if (typeof markdown !== 'string') return ''
  let t = markdown
  t = t.replace(/```[\s\S]*?```/g, ' ')                 // fenced code
  t = t.replace(/```[\s\S]*$/g, ' ')                    // unclosed fence
  t = t.split('\n').filter(line => !/^\s*\|/.test(line)).join('\n') // table rows
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')           // images
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')         // links -> their text
  t = t.replace(/https?:\/\/\S+/g, ' ')                 // bare URLs
  t = t.replace(/`([^`]{1,40})`/g, (_, code) => speakableCode(code)) // short inline code
  t = t.replace(/`[^`]*`/g, ' ')                        // long inline code
  t = t.replace(/^\s{0,3}#{1,6}\s*/gm, '')              // heading marks
  t = t.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')       // list marks
  t = t.replace(/^\s*>\s?/gm, '')                       // quotes
  t = t.replace(/(\*\*|__|\*|_|~~)(\S[^*_~]*?\S|\S)\1/g, '$2') // bold/italic
  t = t.replace(/(?:^|\s)(?:\.{0,2}\/|~\/)?(?:[\w.-]+\/)+[\w.-]+/g, m => ' ' + basename(m.trim())) // paths -> file name
  t = t.replace(/\s*\n+\s*/g, '. ')
  t = t.replace(/\s{2,}/g, ' ')
  t = t.replace(/(\.\s*){2,}/g, '. ')
  t = t.replace(/:\s*\./g, '.')
  t = t.trim().replace(/^[.\s]+/, '')

  // A dot inside a word (login.ts, 3.5) does not end a sentence.
  const sentences = t.match(/(?:[^.!?]|[.!?](?!\s|$))+(?:[.!?]+|$)/g) || []
  let out = ''
  let count = 0
  for (const raw of sentences) {
    const s = raw.trim()
    if (!s) continue
    if (count >= maxSentences) break
    if ((out + ' ' + s).trim().length > maxChars) {
      if (count === 0) out = s.slice(0, maxChars).replace(/\s+\S*$/, '') + '.'
      break
    }
    out = (out + ' ' + s).trim()
    count++
  }
  return out
}

function speakableCode(code) {
  // A short identifier or file name reads fine; symbols do not.
  if (/^[\w.\-/]+$/.test(code)) return basename(code)
  return ' '
}

const COMMANDS = [
  ['stop', /^(stop|stop it|stop claude|stop talking|shut up|halt|quiet|be quiet)$/],
  ['repeat', /^(repeat|repeat that|say that again|say it again|again|what)$/],
  ['send', /^(send|send it|go|submit)$/],
  ['cancel', /^(cancel|never mind|nevermind|forget it|scratch that)$/],
  ['yes', /^(yes|yeah|yep|yup|sure|ok|okay|approve|approved|allow|go ahead|do it|yes please)$/],
  ['no', /^(no|nope|nah|deny|denied|don't|do not|reject|no thanks)$/],
  ['mute', /^(mute|mute spokeline|stop speaking|silence)$/],
  ['unmute', /^(unmute|unmute spokeline|start speaking|speak again)$/],
]

/** Lowercase, drop punctuation and extra spaces: "Stop!" -> "stop". */
export function normalizeSpoken(text) {
  if (typeof text !== 'string') return ''
  return text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

/** If the whole utterance is one of our command words, return the command name. */
export function parseVoiceCommand(text) {
  const n = normalizeSpoken(text)
  if (!n) return null
  for (const [name, re] of COMMANDS) if (re.test(n)) return name
  return null
}

// ---------------------------------------------------------------- switching chats by voice

/**
 * "switch to photobook", "go back to the budget window", "can you move me to the chat called NoteKeeper":
 * the chat's name as said, and whether the sentence itself says chat / window / session / project.
 * Null when the sentence does not start like that. The caller acts only when the name matches an open chat,
 * or when the sentence says "chat" (then it answers that no such chat is open), so "switch to the dark
 * theme" or "go to line 40" still go to Claude as requests.
 */
export function switchRequest(text) {
  const n = normalizeSpoken(text)
  const lead = '^(?:(?:ok|okay|now|please|so|and|then|can you|could you|let\'s|lets|let us)\\s+)*'
  // "switch me back", "go back to the original window", "take me back to where I was": the chat you came from.
  if (new RegExp(lead + '(?:switch|go|move|jump|take|bring)(?:\\s+(?:me|us))?\\s+back' +
    '(?:\\s+to\\s+(?:the\\s+)?(?:original|previous|last|old|other|first)(?:\\s+(?:one|window|chat|tab|session))?' +
    '|\\s+to\\s+where\\s+(?:i|we)\\s+(?:was|were|came\\s+from)|\\s+again)?(?:\\s+please)?$').test(n)) return { back: true, name: '', saysChat: true }
  const m = new RegExp(lead + '(?:switch(?:\\s+(?:me|us|over|back))*\\s+to|change(?:\\s+over)?\\s+to|move(?:\\s+(?:me|us|over|back))*\\s+to|go(?:\\s+(?:back|over))?\\s+to|jump(?:\\s+back)?\\s+to|talk\\s+to|take\\s+me(?:\\s+back)?\\s+to)\\s+(.+?)(?:\\s+please)?$').exec(n) ||
    // "bring the photobook window to the front", "bring up NoteKeeper"
    new RegExp(lead + '(?:bring|show)(?:\\s+(?:me|up|back))*\\s+(.+?)(?:\\s+(?:to the front|to front|forward|up|back))?(?:\\s+please)?$').exec(n)
  if (!m) return null
  // A name is a few words; a long sentence that starts like this is a request for Claude.
  if (m[1].split(' ').length > 6) return null
  let name = m[1]
  const saysChat = /\b(?:chat|window|session|project|tab)\b/.test(name)
  name = name
    .replace(/^(?:the|my|our)\s+/, '')
    .replace(/^(?:chat|window|session|project|tab)(?:\s+(?:called|named|for))?\s+/, '')
    .replace(/\s+(?:chat|window|session|project|tab)(?:\s+one)?$/, '')
    .replace(/^(?:the|my|our)\s+/, '')
    .trim()
  return name ? { back: false, name, saysChat } : null
}

/** A chat name as letters and digits only, lowercase, a doubled letter counted once: "Coffee Shop"
 *  and "CoffeShop" both become "cofeshop". */
export function chatKey(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '').replace(/(\p{L})\1+/gu, '$1')
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

/**
 * The open chat a spoken name means, or null when none fits or two different chats fit equally well.
 * Best: the same name (ignoring spaces, capitals and doubled letters). Then a name that starts the chat's
 * name or the other way round, then one inside the other, then a small spelling difference (one letter in
 * five, at most three): speech recognition writes "note keep her" for "NoteKeeper".
 * Several chats can have the same name (one folder, several chats; old ones keep running in the background).
 * Then the one that runs the current Spokeline with a screen attached wins (`hasScreen`: it can bring its
 * window forward and knows about switching), then the one used last, then the one started last. On
 * 24.11.2026 a chat from the day before got the voice and the window did not come forward.
 * `chats`: [{ id, title, lastActive, hasScreen, startedAt }].
 */
export function matchChat(name, chats) {
  const want = chatKey(name)
  if (want.length < 2 || !Array.isArray(chats)) return null
  const found = []
  for (const c of chats) {
    const k = chatKey(c && c.title)
    if (!k) continue
    const short = Math.min(k.length, want.length)
    const long = Math.max(k.length, want.length)
    let score = 0
    if (k === want) score = 100
    else if (short >= 3 && (k.startsWith(want) || want.startsWith(k))) score = 80
    else if (short >= 4 && short >= 0.6 * long && (k.includes(want) || want.includes(k))) score = 60
    else {
      const d = editDistance(k, want)
      if (d <= Math.min(3, Math.floor(long / 5))) score = 50 - d
    }
    if (score) found.push({ c, score, k })
  }
  if (!found.length) return null
  found.sort((a, b) => b.score - a.score || (b.c.hasScreen ? 1 : 0) - (a.c.hasScreen ? 1 : 0) ||
    (Number(b.c.lastActive) || 0) - (Number(a.c.lastActive) || 0) || (Number(b.c.startedAt) || 0) - (Number(a.c.startedAt) || 0))
  if (found.length > 1 && found[1].score === found[0].score && found[1].k !== found[0].k) return null
  return found[0].c
}

/** A chat's name as it is spoken: "CoffeShop" -> "Coffe Shop", "my_app" -> "my app". */
export function sayableTitle(title) {
  const t = String(title || '').replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim()
  return t === t.toUpperCase() ? t.toLowerCase() : t
}

/** What Spokeline says when no open chat has the name you said. */
export function noSuchChat(name, chats) {
  const names = [...new Set((chats || []).map(c => sayableTitle(c.title)).filter(Boolean))]
  const list = names.length <= 1 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]
  const said = String(name || '').trim()
  return (said ? 'I don\'t see an open chat called ' + said + '. ' : 'Which chat do you mean? ') +
    (names.length ? 'Open chats: ' + list + '.' : 'No other chats are open.')
}

/** A short spoken description of what Claude wants to do, for permission requests. */
export function describeTool(tool, input) {
  const i = input && typeof input === 'object' ? input : {}
  const short = (s, n = 70) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim()
    return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + ' and so on' : t
  }
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return 'run the command ' + short(i.command)
    case 'Edit':
    case 'MultiEdit':
      return 'edit ' + basename(i.file_path)
    case 'Write':
      return 'write the file ' + basename(i.file_path)
    case 'NotebookEdit':
      return 'edit the notebook ' + basename(i.notebook_path)
    case 'Read':
      return 'read ' + basename(i.file_path)
    case 'WebFetch':
      return 'open a web page'
    case 'WebSearch':
      return 'search the web for ' + short(i.query, 50)
    case 'Agent':
    case 'Task':
      return 'start a helper agent' + (i.description ? ' to ' + short(i.description, 50) : '')
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(String(tool))
      if (m) return 'use the tool ' + m[2].replace(/[_-]+/g, ' ') + ' from ' + m[1].replace(/[_-]+/g, ' ')
      return 'use ' + String(tool).replace(/[_-]+/g, ' ')
    }
  }
}

/** Read an AskUserQuestion call aloud: the question and its options. */
export function describeQuestion(input) {
  const qs = input && Array.isArray(input.questions) ? input.questions : []
  const parts = []
  for (const q of qs.slice(0, 2)) {
    const opts = Array.isArray(q.options) ? q.options.map(o => (o && o.label) || '').filter(Boolean) : []
    let s = String(q.question || '').trim()
    if (opts.length) s += ' Options: ' + opts.slice(0, 5).join(', ') + '.'
    parts.push(s)
  }
  return parts.join(' ')
}

/** The prompt we give the small model to turn an answer into speech. */
export const ACK_SYSTEM =
  'A developer just asked a coding assistant something out loud. Before the assistant starts working, ' +
  'reply with ONE very short spoken acknowledgement of at most 8 words that says what will be done, ' +
  'for example "Okay, checking the log." or "Sure, looking at the Windows build." ' +
  'Do not answer the request, do not ask questions, no quotes. Reply with the spoken words only.'

export const STATUS_SYSTEM =
  'You give a developer a spoken progress update while their coding assistant works. You get the steps it ' +
  'took in the last seconds, one per line. Say in ONE short sentence of at most 12 words what it is doing now, ' +
  'in plain words, for example "Now I\'m running the tests." No file paths, no code, no quotes. Spoken words only.'

export const PARTNER_SYSTEM =
  'You are Claude, talking out loud with a developer. You are the voice side of a coding assistant: a ' +
  'separate main session does the real work on screen, and it only gets a task when you send one. You never ' +
  'do the work yourself and never invent results.\n' +
  'Your job: keep a natural spoken conversation, find out what the developer actually wants, and send the ' +
  'main session a clear task only after they agreed. While the main session works, keep them company: answer ' +
  'questions about progress from the steps you are given, and pass on only a real change of course.\n' +
  'You are given the recent history of the coding chat on screen. Answer questions about the project, the ' +
  'work done and its results from that history yourself ("talk"); never send a task just to answer a ' +
  'question the history already answers. Send a task only when the developer wants something done, or wants ' +
  'something looked up that is not in the history.\n' +
  'Choose one action for what the developer just said:\n' +
  '- "talk": conversation, a question you can answer from what you know here, a status question, thinking ' +
  'out loud, or a request that is still unclear (then ask ONE short question to make it clear).\n' +
  '- "propose": the request is clear enough to do. Put the task in "task": a short, complete written ' +
  'instruction for the main session, in the developer\'s terms, with everything agreed in the conversation. ' +
  'In "say", repeat it in a few plain words and ask if you should start.\n' +
  '- "start": the developer agreed to the proposed task (yes, go ahead, do it), or clearly told you to start ' +
  'right now. Put the final task in "task" (the proposed one, with any change they just made). "say" is a ' +
  'short acknowledgement like "Okay, starting now."\n' +
  'When a task is waiting for a yes, anything that sounds like agreement or a go-ahead is "start", even when ' +
  'misheard or partly heard: "yes", "yeah", "sure", "go", "go ahead", "just start", "so just start" (may be heard ' +
  'as "so he just started"), "do it", "I said yes". Only ask again when it clearly is not about the proposal.\n' +
  'When the developer asks you to pass, type or send something to the coding chat, do it: "start" with their ' +
  'words (or the request you discussed) as "task", no proposal needed.\n' +
  '- "change": the main session is working and the developer changes course, corrects it, or adds something ' +
  'it must know. Put the instruction for the main session in "task"; "say" is a short acknowledgement. ' +
  'Comments, worries or questions that need no change are "talk", not "change".\n' +
  'Background helpers: besides the one main coding chat (on screen, for the developer\'s main work), you can ' +
  'start a background helper for supporting work that would otherwise interrupt the main chat: researching a ' +
  'question, checking usage or costs, looking at a website, reading docs. Set "background": true on "propose" ' +
  'or "start" for that. Suggest it yourself when it fits ("Shall I check that in the background?"), especially ' +
  'while the main chat is busy. Work that changes the project\'s code belongs to the main chat, not a helper. ' +
  'At most two helpers run at once. When a helper finished, answer questions about it from its answer.\n' +
  '- "off": the developer wants you to stop listening and switch the microphone off: "that\'s all", "stop ' +
  'listening", "you can stop listening", "turn the microphone off", also inside a longer sentence ("say it, that\'s all", ' +
  '"stop your listening by saying that\'s all"). Not when "that\'s all" only means "only this" at the end of a request ' +
  '("check the logs, that\'s all"). "say" is a short goodbye like "Okay, microphone off." Whenever your "say" tells ' +
  'the developer that the microphone is off or that you stop listening, the action MUST be "off".\n' +
  '- "wait": the sentence is clearly unfinished, cut off in the middle (for example "when I asked you about"). ' +
  '"say" is empty.\n' +
  '- "switch": the developer wants to talk to another of the open chats you are given, for example "let\'s work ' +
  'on NoteKeeper now", "move me over to the photobook chat", "back to Spokeline", "bring the photobook window ' +
  'to the front" (switching brings its window forward; never send that as a task). Put that chat\'s name, as it is ' +
  'listed, in "chat"; it may be misheard ("note keep her" for NoteKeeper, "photo tab" for photobook). Each name is ' +
  'one place even when several chats have it: never ask which one. "Back", "the original window", "where I ' +
  'came from" means the chat the developer came from, when you are told one. "say" is short, like "Okay, switching to NoteKeeper." ' +
  'Only for chats in the list; when it is unclear which one, "talk" and ask. A request about the project that ' +
  'only mentions another project is not a switch.\n' +
  'Speak as "I" ("I\'m checking the code"); never say "the main session" to the developer: to them you are ' +
  'one Claude. Ask at most one question at a time. "say" is 1 to 3 short spoken sentences: plain words, no file ' +
  'paths, no code, no lists. Reply with JSON only: {"action": "...", "say": "...", "task": "...", "background": false, "chat": ""}'

/** Reads the voice partner's JSON answer; null when it is not usable. */
export function parseTalk(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const o = JSON.parse(m[0])
    const action = ['talk', 'propose', 'start', 'change', 'wait', 'off', 'switch'].includes(o.action) ? o.action : null
    if (!action) return null
    const str = v => (typeof v === 'string' ? v.trim() : '')
    return { action, say: str(o.say), task: str(o.task), background: o.background === true, chat: str(o.chat) }
  } catch { return null }
}

/** The voice assistant sometimes answers in plain words instead of the JSON it was asked for (24.11.2026:
 *  "Spokeline is a voice plugin for Claude Code. …"). That is a spoken answer, not a failure: it is said as
 *  it is. Null when the text is empty, very long, or looks like broken JSON. */
export function plainTalk(raw) {
  const t = String(raw || '').trim()
  if (!t || /[{}]/.test(t) || t.length > 1200) return null
  return { action: 'talk', say: t, task: '', background: false, chat: '' }
}

export const SUMMARY_SYSTEM =
  'You turn a coding assistant\'s reply into what a colleague would say out loud to the developer, ' +
  'who is listening, not reading. Use 1 to 3 short sentences in plain spoken language. ' +
  'No code, no markdown, no lists, no URLs, no file paths (a single short file name is fine). ' +
  'Keep important numbers and results. If the reply asks the developer a question or needs a decision, ' +
  'end with that question. Reply with the spoken text only.'

/**
 * From the output of `say -v ?`, pick the most natural voice for the language:
 * "(Premium)" first, then "(Enhanced)". Returns '' when only basic voices exist.
 */
export function chooseVoice(sayList, language) {
  const want = (language || 'en').replace('-', '_').toLowerCase()
  const lang = want.slice(0, 2)
  let best = ''
  let bestScore = 0
  for (const line of String(sayList || '').split('\n')) {
    const m = /^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#/.exec(line)
    if (!m) continue
    const name = m[1].trim()
    const loc = m[2].toLowerCase()
    if (loc.slice(0, 2) !== lang) continue
    let score = /\(premium\)/i.test(name) ? 3 : /\(enhanced\)/i.test(name) ? 2 : 0
    if (score === 0) continue
    if (loc === want) score += 0.5
    if (score > bestScore) { best = name; bestScore = score }
  }
  return best
}

// ---------------------------------------------------------------- natural voice (Kokoro) text preparation
// The Kokoro engine reads only words it has in its dictionary; anything else (digits, odd names) is
// silently skipped. So numbers become words, code-style names are split, and unknown short words are spelled.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/** 42 -> "forty two", 1200 -> "one thousand two hundred". Up to 999,999,999,999. */
export function numberToWords(n) {
  n = Math.floor(Math.abs(n))
  if (n < 20) return ONES[n]
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '')
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + numberToWords(n % 100) : '')
  const units = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]
  for (const [size, name] of units) {
    if (n >= size) {
      const rest = n % size
      return numberToWords(Math.floor(n / size)) + ' ' + name + (rest ? ' ' + numberToWords(rest) : '')
    }
  }
  return String(n)
}

function digitsToWords(s) {
  return s.split('').map(d => ONES[Number(d)]).join(' ')
}

/** Rewrite text so every part of it can be spoken by the Kokoro engine. */
export function prepareForVoice(text) {
  let t = String(text || '')
  // versions: v2.1.3 -> version two point one point three
  t = t.replace(/\bv(\d+(?:\.\d+)+)\b/gi, (_, v) => 'version ' + v.split('.').map(x => numberToWords(+x)).join(' point '))
  // money and percent
  t = t.replace(/\$(\d+(?:\.\d+)?)/g, (_, v) => v + ' dollars')
  t = t.replace(/(\d+(?:\.\d+)?)\s?%/g, (_, v) => v + ' percent')
  // ordinals: 1st, 22nd
  t = t.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_, v) => numberToWords(+v) + (v.endsWith('1') && v !== '11' ? 'st' : v.endsWith('2') && v !== '12' ? 'nd' : v.endsWith('3') && v !== '13' ? 'rd' : 'th'))
  // file names: login.ts -> login dot ts
  t = t.replace(/\b([A-Za-z_][\w-]*)\.([A-Za-z]{1,5})\b/g, (_, name, ext) => name + ' dot ' + ext)
  // decimals and thousands separators
  t = t.replace(/\b(\d{1,3}(?:,\d{3})+)\b/g, m => m.replace(/,/g, ''))
  t = t.replace(/\b(\d+)\.(\d+)\b/g, (_, a, b) => numberToWords(+a) + ' point ' + digitsToWords(b))
  // plain numbers (long digit strings such as ids are read digit by digit)
  t = t.replace(/\b\d+\b/g, m => (m.length > 12 ? digitsToWords(m) : numberToWords(+m)))
  // code-style names: getUserName -> get User Name, snake_case -> snake case, a/b -> a b
  t = t.replace(/([a-z])([A-Z])/g, '$1 $2')
  t = t.replace(/[_/\\]+/g, ' ')
  t = t.replace(/&/g, ' and ').replace(/\+/g, ' plus ').replace(/=/g, ' equals ')
  t = t.replace(/[#*`~^<>|{}\[\]]/g, ' ')
  return t.replace(/\s{2,}/g, ' ').trim()
}

/**
 * After the engine reported words it could not read: spell short ones letter by letter ("vite" -> "v i t e"
 * is still better than silence), and drop long ones.
 */
export function fixUnknownWords(text, unknown) {
  let t = String(text || '')
  for (const raw of new Set(unknown || [])) {
    const w = String(raw)
    if (!w) continue
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp('(^|[^\\p{L}\\p{N}])' + esc + '(?=$|[^\\p{L}\\p{N}])', 'gu')
    const letters = /^[\p{L}]+$/u.test(w) && w.length <= 5 ? w.toLowerCase().split('').join(' ') : ''
    t = t.replace(re, (_, pre) => pre + letters)
  }
  return t.replace(/\s{2,}/g, ' ').trim()
}

/** The words the engine skipped, from its log: "OOV word skipped: 'xyz'". */
export function parseUnknownWords(log) {
  const out = []
  const re = /OOV word skipped: '([^']*)'/g
  let m
  while ((m = re.exec(String(log || ''))) !== null) out.push(m[1])
  return out
}

/** Split spoken text into sentences, so the first can play while the next is being made. */
export function splitSentences(text) {
  const parts = String(text || '').match(/(?:[^.!?]|[.!?](?!\s|$))+(?:[.!?]+|$)/g) || []
  const out = []
  for (const p of parts) {
    const s = p.trim()
    if (!s) continue
    // join very short pieces to the previous one: fewer pauses
    if (out.length && (s.length < 25 || out[out.length - 1].length < 25)) out[out.length - 1] += ' ' + s
    else out.push(s)
  }
  return out
}

/** The natural voices offered in the settings: Kokoro speaker id and accent. */
export const NATURAL_VOICES = {
  heart: { sid: 3, accent: 'us' },
  bella: { sid: 2, accent: 'us' },
  nicole: { sid: 6, accent: 'us' },
  sarah: { sid: 9, accent: 'us' },
  michael: { sid: 16, accent: 'us' },
  adam: { sid: 11, accent: 'us' },
  puck: { sid: 18, accent: 'us' },
  emma: { sid: 21, accent: 'gb' },
  isabella: { sid: 22, accent: 'gb' },
  george: { sid: 26, accent: 'gb' },
  fable: { sid: 25, accent: 'gb' },
}

// The list shown while you type /spokeline: each command with a short explanation.
export const SPOKELINE_COMMANDS = [
  ['menu', 'open the menu: listening, voice, microphone, speakers'],
  ['status', 'show whether Spokeline is on and how it listens'],
  ['stop', 'stop the voice or the work now'],
  ['repeat', 'say the last answer again'],
  ['mute', 'stop speaking answers'],
  ['unmute', 'speak answers again'],
  ['here', 'send your voice to this chat'],
  ['listen', 'choose how it listens: off, ptt, handsfree'],
  ['voice', 'show or choose the voice'],
  ['say', 'send text as if you had said it'],
  ['talk', 'type to the voice partner; it answers out loud'],
  ['helper', 'start a background helper for supporting work'],
  ['helpers', 'show the background helpers'],
]
const LISTEN_CHOICES = [
  ['off', 'never use the microphone'],
  ['ptt', 'hold the key while you speak'],
  ['handsfree', 'say the wake phrase, then your request'],
]

/// The rows to offer for the word being typed (`token`, which starts at `start` in `text`):
/// the commands after "/spokeline", and the choices after "listen" and "voice".
export function commandSuggestions(text, token, start, voices = []) {
  const t = String(token || '').toLowerCase()
  const before = String(text || '').slice(0, start)
  const rows = (list, prefix, lead = '') => list.filter(([w]) => w.startsWith(prefix))
    .map(([w, d]) => ({ text: lead + w, label: lead ? '/spokeline ' + w : w, description: d }))
  // "/spok" ... "/spokeline": the whole command with each word after it.
  if (start === 0 && t.length >= 5 && '/spokeline'.startsWith(t)) return rows(SPOKELINE_COMMANDS, '', '/spokeline ')
  const m = /^\/spokeline\s+(?:(listen|voice)\s+)?$/i.exec(before)
  if (!m) return []
  const sub = (m[1] || '').toLowerCase()
  if (sub === 'listen') return rows(LISTEN_CHOICES, t)
  if (sub === 'voice') return rows([['install', 'download the natural voice'], ['system', 'use the built-in voice'], ...voices.map(v => [v, 'natural voice'])], t)
  const found = rows(SPOKELINE_COMMANDS, t)
  return found.length === 1 && found[0].text === t ? [] : found
}

/// The line shown all the time at the bottom of the chat: what the microphone is doing now.
/// `ears` is ~/.spokeline/ears.json (written by the listening helper about once a second), `live` the
/// unfinished words you are saying, `me` this chat's id. Returns undefined when nothing should show.
/// The line shown all the time above the prompt: what the microphone is doing now, without the sign
/// (the sign is drawn on its own, with a green light while it hears you: see micHearing).
/// `ears` is ~/.spokeline/ears.json (written by the listening helper), `live` the unfinished words you are
/// saying, `me` this chat's id. Returns undefined when the helper never ran (no state file).
export function micLine(ears, live, now, me, pluginMode) {
  if (pluginMode === 'off') return 'Spokeline: microphone off'
  if (!ears || typeof ears !== 'object') return undefined
  if (ears.state === 'closed' || !(now - (Number(ears.ts) || 0) < 8000)) return 'Spokeline: microphone helper not running'
  if (ears.mode === 'off') return 'Spokeline: microphone off'
  const key = String(ears.hotkey || 'the key')
  if (ears.target && me && ears.target !== me) return 'Spokeline: listening for another chat · /spokeline here to switch'
  switch (ears.state) {
    case 'recording': return 'Spokeline: recording… · release ' + key + ' to send'
    case 'recognizing': return 'Spokeline: working out what you said…'
    case 'capturing': return 'Spokeline: hearing you…'
    case 'listening':
      // Push to talk keeps the microphone open but takes nothing until the key is held: say so.
      if (ears.mode === 'push_to_talk') return 'Spokeline: push to talk · hold ' + key + ' and speak'
      if (live && String(live.text || '').trim()) return 'Spokeline: hearing you…'
      return ears.conversation
        ? 'Spokeline: listening · in a conversation · say "that\'s all" to switch the microphone off'
        : 'Spokeline: listening · say "' + String(ears.wake || 'Claude') + '…" or hold ' + key
    case 'idle': return ears.mode === 'hands_free'
      ? 'Spokeline: microphone not open yet'
      : 'Spokeline: ready · hold ' + key + ' and speak'
    default: return ears.mode === 'hands_free' && ears.speechPack === false
      ? 'Spokeline: waiting for the speech pack'
      : 'Spokeline: microphone not open'
  }
}

/// True while the microphone hears you speaking right now (the green light on the microphone sign).
export function micHearing(ears, now, me, pluginMode) {
  if (pluginMode === 'off' || !ears || typeof ears !== 'object') return false
  if (ears.state === 'closed' || !(now - (Number(ears.ts) || 0) < 8000) || ears.mode === 'off') return false
  if (ears.target && me && ears.target !== me) return false
  return ears.hearing === true
}

/// How many of the three bars next to the microphone sign are lit: 0 while it does not hear you speak,
/// then 1 to 3 by how loud you are (from "level" in ears.json; 1 when an older helper does not write it).
export function micLevel(ears, now, me, pluginMode) {
  if (!micHearing(ears, now, me, pluginMode)) return 0
  const n = Math.round(Number(ears.level) || 0)
  return Math.min(3, Math.max(1, n))
}

/// The rows under the microphone line: your last three questions, oldest first, the current one last (what
/// you are saying now, or else the last one you said), all within `maxRows` screen rows of `width` cells.
/// The current one gets the room first (its end kept when it is too long); older ones keep their start.
export function historyRows(history, live, width, maxRows = 16) {
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim()
  const past = (Array.isArray(history) ? history : []).map(clean).filter(Boolean)
  const now = clean(live)
  const items = now ? [...past.slice(-2), now] : past.slice(-3)
  if (!items.length) return []
  const w = Math.max(10, Math.floor(width))
  const rowsOf = (t) => Math.max(1, Math.ceil(t.length / w))
  const out = []
  let left = Math.max(1, Math.floor(maxRows))
  for (let i = items.length - 1; i >= 0 && left > 0; i--) {
    const current = i === items.length - 1
    const room = Math.max(1, left - i)            // keep one row for each older question still to come
    let t = items[i]
    if (rowsOf(t) > room) {
      const max = room * w - 1
      t = current ? '…' + t.slice(t.length - max) : t.slice(0, max) + '…'
    }
    left -= rowsOf(t)
    out.unshift({ text: t, current, speaking: current && !!now })
  }
  return out
}

/// What you are saying right now, in full, for the rows under the microphone line (wrapped over as many
/// rows as it needs). When it is longer than `room` characters, its end is shown with "…" before it.
export function micWords(ears, live, now, me, room = 2000) {
  if (!ears || !live || !(now - (Number(ears.ts) || 0) < 8000)) return ''
  if (ears.target && me && ears.target !== me) return ''
  if (!['capturing', 'recording', 'listening'].includes(ears.state)) return ''
  const t = String(live.text || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const max = Math.max(40, Math.floor(room))
  return t.length > max ? '…' + t.slice(t.length - max + 1) : t
}

/// One line about a background helper that is working, for the row above the prompt.
export function helperLine(label, seconds, lastStep) {
  const s = Math.max(0, Math.round(seconds))
  const time = s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s'
  return 'Background check (' + time + '): ' + label + (lastStep ? ' · now: ' + lastStep : ' · starting')
}

export const HELPER_STATUS_SYSTEM =
  'You give a developer a spoken progress update about a background check their assistant is running for ' +
  'them. You get what the check is about and its latest steps, one per line. Say in ONE short sentence of at ' +
  'most 14 words what the background check is doing now, starting with "The background check", for example ' +
  '"The background check is reading the pricing page now." No file paths, no code, no quotes.'
