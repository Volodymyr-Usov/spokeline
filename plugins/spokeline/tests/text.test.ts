import { expect, test } from 'claude-code/testing'
import { cleanForSpeech, describeTool, isShortPlain, parseVoiceCommand, describeQuestion, chooseVoice, numberToWords, prepareForVoice, parseUnknownWords, fixUnknownWords, splitSentences, parseTalk, plainTalk, switchRequest, matchChat, chatKey, sayableTitle, noSuchChat, commandSuggestions, micLine, micHearing, micLevel, micWords, helperLine, historyRows, startMode, quietTooLong, idleOffMinutes, idleOffLabel } from '../hooks/text.js'

test('code, tables, links and paths are not read aloud', async () => {
  const answer = [
    '## Done',
    'I fixed the login bug in `src/auth/login.ts` and added a test.',
    '',
    '```ts',
    'export function login() { return true }',
    '```',
    '',
    '| File | Change |',
    '|---|---|',
    '| login.ts | fixed |',
    '',
    'See [the docs](https://example.com/docs) for details. All 42 tests pass.',
  ].join('\n')
  const spoken = cleanForSpeech(answer)
  expect(spoken).not.toContain('```')
  expect(spoken).not.toContain('export function')
  expect(spoken).not.toContain('|')
  expect(spoken).not.toContain('https://')
  expect(spoken).not.toContain('src/auth/')
  expect(spoken).toContain('login.ts')
  expect(spoken).toContain('the docs')
})

test('only the first sentences are kept', async () => {
  const spoken = cleanForSpeech('One. Two. Three. Four. Five.', 3)
  expect(spoken).toBe('One. Two. Three.')
})

test('short plain answers are spoken as they are', async () => {
  expect(isShortPlain('Done, all tests pass.')).toBe(true)
  expect(isShortPlain('Run `npm test` now.')).toBe(false)
  expect(isShortPlain('x'.repeat(300))).toBe(false)
})

test('spoken commands are recognised only as whole utterances', async () => {
  expect(parseVoiceCommand('Stop!')).toBe('stop')
  expect(parseVoiceCommand('stop claude')).toBe('stop')
  expect(parseVoiceCommand('Say that again.')).toBe('repeat')
  expect(parseVoiceCommand('Yes please')).toBe('yes')
  expect(parseVoiceCommand('nope')).toBe('no')
  expect(parseVoiceCommand('stop the server and restart it')).toBe(null)
  expect(parseVoiceCommand('add a test for the login function')).toBe(null)
})

test('permission requests are described in plain words', async () => {
  expect(describeTool('Bash', { command: 'npm test' })).toBe('run the command npm test')
  expect(describeTool('Edit', { file_path: '/a/b/login.ts' })).toBe('edit login.ts')
  expect(describeTool('mcp__github__create_issue', {})).toBe('use the tool create issue from github')
})

test('questions are read with their options', async () => {
  const q = describeQuestion({ questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] })
  expect(q).toBe('Which database? Options: Postgres, SQLite.')
})

test('the most natural installed voice is chosen', async () => {
  const list = [
    'Daniel              en_GB    # Hello! My name is Daniel.',
    'Samantha            en_US    # Hello! My name is Samantha.',
    'Ava (Enhanced)      en_US    # Hello! My name is Ava.',
    'Zoe (Premium)       en_US    # Hello! My name is Zoe.',
    'Anna (Premium)      de_DE    # Hallo! Ich heiße Anna.',
  ].join('\n')
  expect(chooseVoice(list, '')).toBe('Zoe (Premium)')
  expect(chooseVoice(list, 'de-DE')).toBe('Anna (Premium)')
  expect(chooseVoice('Samantha            en_US    # Hello!', '')).toBe('')
})

test('numbers and code words become speakable words', async () => {
  expect(numberToWords(42)).toBe('forty two')
  expect(numberToWords(1205)).toBe('one thousand two hundred five')
  expect(prepareForVoice('All 42 tests pass in 3.5 seconds.')).toBe('All forty two tests pass in three point five seconds.')
  expect(prepareForVoice('Fixed login.ts and getUserName.')).toBe('Fixed login dot ts and get User Name.')
  expect(prepareForVoice('Upgraded to v2.1 (90% done).')).toBe('Upgraded to version two point one (ninety percent done).')
})

test('unknown words are spelled when short and dropped when long', async () => {
  expect(parseUnknownWords("x OOV word skipped: 'vite'\ny OOV word skipped: 'zzzlongword'")).toEqual(['vite', 'zzzlongword'])
  expect(fixUnknownWords('Use vite here and zzzlongword there.', ['vite', 'zzzlongword'])).toBe('Use v i t e here and there.')
})

test('sentences are split for streaming, short ones joined', async () => {
  expect(splitSentences('Done. All tests pass, and the build is green. Want me to open a pull request now?')).toEqual(['Done. All tests pass, and the build is green.', 'Want me to open a pull request now?'])
})

test('the voice partner answer is read safely', () => {
  expect(parseTalk('{"action":"talk","say":"Yes, I can hear you."}')).toEqual({ action: 'talk', say: 'Yes, I can hear you.', task: '', background: false, chat: '' })
  expect(parseTalk('Sure: {"action": "propose", "say": "Shall I start?", "task": "Remove unused files."} ok')).toEqual({ action: 'propose', say: 'Shall I start?', task: 'Remove unused files.', background: false, chat: '' })
  expect(parseTalk('{"action":"start","say":"On it.","task":"Check the usage page.","background":true}')).toEqual({ action: 'start', say: 'On it.', task: 'Check the usage page.', background: true, chat: '' })
  expect(parseTalk('no json here')).toBe(null)
  expect(parseTalk('{"action":"dance"}')).toBe(null)
})

test('the list of commands while typing /spokeline', async () => {
  const all = commandSuggestions('/spokeline', '/spokeline', 0)
  expect(all.length).toBe(13)
  expect(all[1]).toEqual({ text: '/spokeline status', label: '/spokeline status', description: 'show whether Spokeline is on and how it listens' })
  expect(commandSuggestions('/spok', '/spok', 0).length).toBe(13)
  expect(commandSuggestions('/sp', '/sp', 0)).toEqual([])
  expect(commandSuggestions('/spokeline s', 's', 11).map(r => r.text)).toEqual(['status', 'stop', 'say'])
  expect(commandSuggestions('/spokeline stop', 'stop', 11)).toEqual([])
  expect(commandSuggestions('/spokeline listen h', 'h', 18).map(r => r.text)).toEqual(['handsfree'])
  expect(commandSuggestions('/spokeline voice e', 'e', 17, ['emma', 'george']).map(r => r.text)).toEqual(['emma'])
  expect(commandSuggestions('/spokeline say stop', 'stop', 15)).toEqual([])
  expect(commandSuggestions('please stop', 'stop', 7)).toEqual([])
})

test('the microphone line shown all the time', async () => {
  const now = 1_000_000
  const ears = (o) => ({ state: 'listening', hearing: false, mode: 'hands_free', conversation: false, target: 'me', hotkey: 'Ctrl+Alt+V', wake: 'claude', speechPack: true, ts: now - 1000, ...o })
  expect(micLine(ears({}), null, now, 'me', 'hands_free')).toBe('Spokeline: listening · say "claude…" or hold Ctrl+Alt+V')
  expect(micLine(ears({ conversation: true }), null, now, 'me', 'hands_free')).toContain("say \"that's all\" to switch the microphone off")
  expect(micLine(ears({ mode: 'push_to_talk' }), null, now, 'me', 'push_to_talk')).toBe('Spokeline: push to talk · hold Ctrl+Alt+V and speak')
  expect(micLine(ears({ state: 'capturing' }), { text: 'run the tests' }, now, 'me', 'hands_free')).toBe('Spokeline: hearing you…')
  expect(micLine(ears({ state: 'capturing' }), null, now, 'me', 'hands_free')).toBe('Spokeline: hearing you…')
  expect(micLine(ears({ state: 'recording' }), null, now, 'me', 'push_to_talk')).toBe('Spokeline: recording… · release Ctrl+Alt+V to send')
  expect(micLine(ears({ state: 'idle', mode: 'push_to_talk' }), null, now, 'me', 'push_to_talk')).toBe('Spokeline: ready · hold Ctrl+Alt+V and speak')
  expect(micLine(ears({ target: 'other' }), null, now, 'me', 'hands_free')).toContain('another chat')
  expect(micLine(ears({ ts: now - 20000 }), null, now, 'me', 'hands_free')).toBe('Spokeline: microphone helper not running')
  expect(micLine(ears({ state: 'closed' }), null, now, 'me', 'hands_free')).toBe('Spokeline: microphone helper not running')
  expect(micLine(ears({ state: 'off', speechPack: false }), null, now, 'me', 'hands_free')).toBe('Spokeline: waiting for the speech pack')
  expect(micLine(null, null, now, 'me', 'hands_free')).toBe(undefined)
  expect(micLine(ears({}), null, now, 'me', 'off')).toBe('Spokeline: microphone off')
  // No moving bars any more: the line never holds them.
  expect(/[▁▃▅▇]/.test(micLine(ears({ state: 'capturing', hearing: true }), null, now, 'me', 'hands_free'))).toBe(false)
})

test('the green light on the microphone sign: on only while it hears you', async () => {
  const now = 1_000_000
  const ears = (o) => ({ state: 'listening', hearing: true, mode: 'hands_free', target: 'me', ts: now - 500, ...o })
  expect(micHearing(ears({}), now, 'me', 'hands_free')).toBe(true)
  expect(micHearing(ears({ hearing: false }), now, 'me', 'hands_free')).toBe(false)
  expect(micHearing(ears({ ts: now - 20000 }), now, 'me', 'hands_free')).toBe(false)
  expect(micHearing(ears({ target: 'other' }), now, 'me', 'hands_free')).toBe(false)
  expect(micHearing(ears({}), now, 'me', 'off')).toBe(false)
  expect(micHearing(null, now, 'me', 'hands_free')).toBe(false)
})

test('the three bars next to the microphone sign follow how loud you speak', async () => {
  const now = 1_000_000
  const ears = (o) => ({ state: 'listening', hearing: true, level: 2, mode: 'hands_free', target: 'me', ts: now - 500, ...o })
  expect(micLevel(ears({}), now, 'me', 'hands_free')).toBe(2)
  expect(micLevel(ears({ level: 3 }), now, 'me', 'hands_free')).toBe(3)
  expect(micLevel(ears({ level: undefined }), now, 'me', 'hands_free')).toBe(1)
  expect(micLevel(ears({ hearing: false, level: 3 }), now, 'me', 'hands_free')).toBe(0)
  expect(micLevel(ears({ target: 'other' }), now, 'me', 'hands_free')).toBe(0)
})

test('your words while you speak: in full on their own rows, the end kept when very long', async () => {
  const now = 1_000_000
  const ears = { state: 'capturing', target: 'me', ts: now - 500 }
  const long = 'word '.repeat(300).trim()
  expect(micWords(ears, { text: 'run  the\ntests' }, now, 'me')).toBe('run the tests')
  expect(micWords(ears, { text: long }, now, 'me').length).toBeLessThan(2001)
  expect(micWords(ears, { text: long }, now, 'me', 100)).toBe('…' + long.slice(long.length - 99))
  expect(micWords({ ...ears, target: 'other' }, { text: 'hi' }, now, 'me')).toBe('')
  expect(micWords({ ...ears, state: 'off' }, { text: 'hi' }, now, 'me')).toBe('')
  expect(micWords(ears, null, now, 'me')).toBe('')
})

test('a background check shows what it does', async () => {
  expect(helperLine('Check the pricing page', 45, 'read the web page example.com')).toBe('Background check (45 s): Check the pricing page · now: read the web page example.com')
  expect(helperLine('Check usage', 75, '')).toBe('Background check (1 min 15 s): Check usage · starting')
})

test('your last three questions under the microphone line, the current one marked, at most 16 rows', async () => {
  const rows = (r, w) => r.reduce((n, x) => n + Math.max(1, Math.ceil(x.text.length / w)), 0)
  const three = historyRows(['one', 'two', 'three', 'four'], '', 40)
  expect(three.map(x => x.text)).toEqual(['two', 'three', 'four'])
  expect(three.map(x => x.current)).toEqual([false, false, true])
  const speaking = historyRows(['one', 'two', 'three'], 'what I say now', 40)
  expect(speaking.map(x => x.text)).toEqual(['two', 'three', 'what I say now'])
  expect(speaking[2].speaking).toBe(true)
  const long = 'word '.repeat(300).trim()
  const big = historyRows([long, long], long, 40)
  expect(rows(big, 40)).toBeLessThan(17)
  expect(big.length).toBe(3)
  expect(big[2].text.startsWith('…')).toBe(true)
  expect(historyRows([], '', 40)).toEqual([])
})
test('the voice helper can switch the microphone off', async () => {
  expect(parseTalk('{"action":"off","say":"Okay, microphone off."}')).toEqual({ action: 'off', say: 'Okay, microphone off.', task: '', background: false, chat: '' })
})

test('switching chats by voice: what counts as a switch', async () => {
  expect(switchRequest('Switch to photobook.')).toEqual({ name: 'photobook', saysChat: false, back: false })
  expect(switchRequest('go back to the budget window')).toEqual({ name: 'budget', saysChat: true, back: false })
  expect(switchRequest('Can you move me to the chat called NoteKeeper, please?')).toEqual({ name: 'notekeeper', saysChat: true, back: false })
  expect(switchRequest("Let's switch over to Coffee Shop")).toEqual({ name: 'coffee shop', saysChat: false, back: false })
  expect(switchRequest('talk to the Spokeline chat')).toEqual({ name: 'spokeline', saysChat: true, back: false })
  expect(switchRequest('switch to the dark theme')).toEqual({ name: 'dark theme', saysChat: false, back: false })
  expect(switchRequest('please fix the tests')).toBe(null)
  expect(switchRequest('I want to switch to Python later')).toBe(null)
  expect(switchRequest('Can you switch to the photo window?')).toEqual({ name: 'photo', saysChat: true, back: false })
  expect(switchRequest('Bring the photobook window to the front.')).toEqual({ name: 'photobook', saysChat: true, back: false })
  expect(switchRequest('bring up NoteKeeper')).toEqual({ name: 'notekeeper', saysChat: false, back: false })
  expect(switchRequest('show me the logs')).toEqual({ name: 'logs', saysChat: false, back: false })   // no chat is called that: a request
  // A long sentence is a request for Claude, even when it starts like a switch.
  expect(switchRequest("Bring the photobook VS Code window to the front, using VS Code's code command on that window's own folder.")).toBe(null)
  expect(switchRequest('Can you shoot me to the photo tab?')).toBe(null)                  // misheard: the voice assistant handles it
  expect(switchRequest('go to the photo tab')).toEqual({ name: 'photo', saysChat: true, back: false })
  // Back to the chat you came from.
  for (const said of ['Can you switch me back?', 'go back', 'Take me back to the original window.', 'switch back to where I was', 'go back to the previous chat please'])
    expect(switchRequest(said)).toEqual({ back: true, name: '', saysChat: true })
  // Not a way back: a name no chat has, so it stays a request for Claude.
  expect(switchRequest('go back to the last commit')).toEqual({ name: 'last commit', saysChat: false, back: false })
})

test('switching chats by voice: a spoken name finds the open chat', async () => {
  const chats = [
    { id: 'a', title: 'NoteKeeper', lastActive: 1 },
    { id: 'b', title: 'photobook', lastActive: 5 },
    { id: 'c', title: 'CoffeShop', lastActive: 2 },
    { id: 'd', title: 'BUDGET', lastActive: 3 },
    { id: 'e', title: 'Spokeline', lastActive: 4 },
    { id: 'f', title: 'photobook', lastActive: 9 },
  ]
  expect(chatKey('Coffee Shop')).toBe(chatKey('CoffeShop'))
  expect(matchChat('coffee shop', chats)?.id).toBe('c')
  expect(matchChat('note keep her', chats)?.id).toBe('a')
  expect(matchChat('note keeper', chats)?.id).toBe('a')
  expect(matchChat('budget', chats)?.id).toBe('d')
  expect(matchChat('spoke line', chats)?.id).toBe('e')
  expect(matchChat('photo look', chats)?.id).toBe('f')          // misheard, and the one used last of the two
  expect(matchChat('photobook', chats)?.id).toBe('f')
  expect(matchChat('dark theme', chats)).toBe(null)
  expect(matchChat('line', chats)).toBe(null)
  expect(matchChat('python', chats)).toBe(null)
  // Several chats with one name: the one with the current Spokeline and a screen, then the one used last,
  // then the newest (24.11.2026: a chat from the day before got the voice).
  const same = [
    { id: 'old1', title: 'photobook', lastActive: 50, hasScreen: false, startedAt: 1 },
    { id: 'old2', title: 'photobook', lastActive: 0, hasScreen: false, startedAt: 2 },
    { id: 'new', title: 'photobook', lastActive: 0, hasScreen: true, startedAt: 3 },
  ]
  expect(matchChat('photobook', same)?.id).toBe('new')
  expect(matchChat('photobook', [same[0], same[1]])?.id).toBe('old1')
  expect(matchChat('photobook', [{ ...same[0], lastActive: 0 }, same[1]])?.id).toBe('old2')
  // Two different chats that fit equally: ask instead of guessing.
  const two = [{ id: 'x', title: 'apple-web' }, { id: 'y', title: 'apple-ios' }]
  expect(matchChat('apple', two)).toBe(null)
  expect(matchChat('apple web', two)?.id).toBe('x')
})

test('switching chats by voice: what is said', async () => {
  expect(sayableTitle('CoffeShop')).toBe('Coffe Shop')
  expect(sayableTitle('BUDGET')).toBe('budget')
  expect(sayableTitle('my_app')).toBe('my app')
  expect(noSuchChat('python', [{ title: 'NoteKeeper' }, { title: 'BUDGET' }, { title: 'NoteKeeper' }])).toBe("I don't see an open chat called python. Open chats: Note Keeper and budget.")
  expect(noSuchChat('', [{ title: 'Spokeline' }])).toBe('Which chat do you mean? Open chats: Spokeline.')
  expect(noSuchChat('x', [])).toBe("I don't see an open chat called x. No other chats are open.")
  expect(parseTalk('{"action":"switch","say":"Okay, switching to NoteKeeper.","chat":"NoteKeeper"}')).toEqual({ action: 'switch', say: 'Okay, switching to NoteKeeper.', task: '', background: false, chat: 'NoteKeeper' })
})

test('the voice assistant answering in plain words is said as it is', async () => {
  expect(plainTalk('Spokeline is a voice plugin for Claude Code.')).toEqual({ action: 'talk', say: 'Spokeline is a voice plugin for Claude Code.', task: '', background: false, chat: '' })
  expect(plainTalk('')).toBe(null)
  expect(plainTalk('{"action": "talk", "say": "cut off')).toBe(null)
})

test('a new chat or a restart starts in push to talk, and keeps hands free only if the voice was used lately', async () => {
  const now = 1_000_000_000
  const min = 60000
  expect(startMode(null, now)).toBe('push_to_talk')                                     // first start
  expect(startMode({ mode: 'hands_free' }, now)).toBe('push_to_talk')                   // older file: no activeAt
  expect(startMode({ mode: 'hands_free', activeAt: now - 20 * min }, now)).toBe('push_to_talk')  // quiet for 20 minutes
  expect(startMode({ mode: 'hands_free', activeAt: now - 5 * min }, now)).toBe('hands_free')
  expect(startMode({ mode: 'push_to_talk', activeAt: now - 90 * min }, now)).toBe('push_to_talk')  // push to talk never switches off
  expect(startMode({ mode: 'off', activeAt: now }, now)).toBe('off')                    // off is a person's choice
  expect(startMode({ mode: 'hands_free', activeAt: now - 50 * min, idleOffMinutes: 60 }, now)).toBe('hands_free')
  expect(startMode({ mode: 'hands_free', activeAt: 0, idleOffMinutes: 0 }, now)).toBe('hands_free')  // never
})

test('the microphone switches off after the chosen quiet minutes', async () => {
  const now = 1_000_000_000
  const min = 60000
  expect(idleOffMinutes({})).toBe(15)
  expect(idleOffMinutes({ idleOffMinutes: 30 })).toBe(30)
  expect(idleOffMinutes({ idleOffMinutes: 0 })).toBe(0)
  expect(idleOffMinutes({ idleOffMinutes: 7 })).toBe(15)        // not a menu choice
  expect(quietTooLong({ activeAt: now - 14 * min }, now)).toBe(false)
  expect(quietTooLong({ activeAt: now - 16 * min }, now)).toBe(true)
  expect(quietTooLong({ activeAt: now - 16 * min, idleOffMinutes: 30 }, now)).toBe(false)
  expect(quietTooLong({ activeAt: 0, idleOffMinutes: 0 }, now)).toBe(false)
  expect(idleOffLabel(15)).toBe('15 quiet minutes')
  expect(idleOffLabel(0)).toBe('never')
})
