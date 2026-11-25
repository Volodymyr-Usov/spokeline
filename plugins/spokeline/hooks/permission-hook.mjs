// Spokeline's PermissionRequest hook on Windows ("Approve by voice", off unless you switch it on).
// The Mac uses permission-hook.sh instead; there this file does nothing.
//
// Claude Code runs it only when a permission box is about to be shown. It acts only while "Approve by voice"
// is on and you are talking to this chat by voice (Spokeline writes both into its session file, together with
// a heartbeat every two seconds). Then it writes the request to ~/.spokeline/permission/<chat id>.json, where
// Spokeline reads it aloud, and waits a few seconds for your spoken answer, which Spokeline writes to
// ~/.spokeline/permission/<chat id>.answer. "yes" allows this one request, "no" denies it. With no spoken
// answer in time, or in any other case, it prints nothing and the normal permission box appears as usual.
// It reads and writes only files in ~/.spokeline, and sends nothing over the network.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

if (process.platform === 'darwin') process.exit(0)

const base = path.join(process.env.USERPROFILE || process.env.HOME || '', '.spokeline')
const safeName = s => String(s).replace(/[^\p{L}\p{N}_-]/gu, '')
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
const log = text => {
  try { fs.appendFileSync(path.join(base, 'ears.log'), new Date().toISOString().replace(/\.\d+Z$/, 'Z') + ' ' + text + '\n') } catch { /* no log */ }
}

let input = ''
for await (const chunk of process.stdin) input += chunk
let request = null
try { request = JSON.parse(input) } catch { process.exit(0) }
const sessionId = typeof request?.session_id === 'string' ? request.session_id : ''
if (!sessionId) process.exit(0)
const tool = typeof request.tool_name === 'string' ? request.tool_name : ''
const toolInput = request.tool_input ?? {}
const sid = safeName(sessionId)

// Only while this chat is in a voice conversation with "Approve by voice" on, and Spokeline is running in it.
const session = readJson(path.join(base, 'sessions', sid + '.json'))
if (!session || session.voiceFlow !== true || !(Date.now() - Number(session.heartbeat || 0) < 8000)) process.exit(0)
const waitSeconds = Math.min(120, Math.max(5, Number(session.approvalWaitSeconds) || 20))

const folder = path.join(base, 'permission')
fs.mkdirSync(folder, { recursive: true })
const id = crypto.randomUUID()
const requestFile = path.join(folder, sid + '.json')
const answerFile = path.join(folder, sid + '.answer')
try { fs.unlinkSync(answerFile) } catch { /* none */ }
const writeRequest = state => {
  const text = JSON.stringify({ id, tool, input: toolInput, state, ts: Date.now() })
  try { fs.writeFileSync(requestFile + '.tmp', text); fs.renameSync(requestFile + '.tmp', requestFile) } catch { try { fs.writeFileSync(requestFile, text) } catch { /* ignore */ } }
}
writeRequest('waiting')
log('permission request for ' + tool + ' in ' + sid.slice(0, 8) + ', waiting ' + waitSeconds + ' s for a spoken answer')

// Spokeline needs time to read the request aloud before you can answer.
const deadline = Date.now() + (waitSeconds + 8) * 1000
while (Date.now() < deadline) {
  const answer = readJson(answerFile)
  if (answer && answer.id === id && typeof answer.answer === 'string') {
    try { fs.unlinkSync(answerFile) } catch { /* gone */ }
    writeRequest('answered')
    log('permission answered by voice: ' + answer.answer)
    const decision = answer.answer === 'yes'
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: 'The user said no by voice.' }
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }))
    process.exit(0)
  }
  await new Promise(resolve => setTimeout(resolve, 200))
}
writeRequest('timeout')
log('no spoken answer, showing the permission box')
