import fs from 'node:fs'
import { spawn } from 'node:child_process'

let runner
let stopping = false
let configured = false

function signalGroup(signal) {
  try {
    if (process.platform !== 'win32') process.kill(-process.pid, signal)
    else runner?.kill(signal)
  } catch (error) {
    if (error.code !== 'ESRCH') process.exitCode = 1
  }
}

function stop() {
  if (stopping) return
  stopping = true
  signalGroup('SIGTERM')
  setTimeout(() => {
    signalGroup('SIGKILL')
    process.exit(1)
  }, 1000)
}

function report(message, callback) {
  if (!process.connected) { callback?.(); return }
  try { process.send(message, () => callback?.()) } catch { callback?.() }
}

process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.on('disconnect', stop)
process.stdin.on('error', () => { report({ type: 'stdin_error' }); stop() })
process.stdout.on('error', stop)
process.stderr.on('error', stop)
process.on('message', (message) => {
  if (configured || stopping) return
  configured = true
  if (message?.type !== 'configure' || typeof message.command !== 'string'
    || !Array.isArray(message.args) || message.args.some((arg) => typeof arg !== 'string')) {
    report({ type: 'spawn_error' }, stop)
    return
  }
  try {
    if (process.platform !== 'linux' || !fs.fstatSync(4).isDirectory()) throw new Error('runner_platform_unsupported')
    process.chdir('/proc/self/fd/4')
    fs.closeSync(4)
    runner = spawn(message.command, message.args, {
      shell: false, detached: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    runner.once('spawn', () => report({ type: 'started' }))
    runner.once('error', () => report({ type: 'spawn_error' }))
    runner.once('close', (code, signal) => report({ type: 'result', code, signal }, stop))
    runner.stdin.on('error', () => { report({ type: 'stdin_error' }); stop() })
    runner.stdout.on('error', stop)
    runner.stderr.on('error', stop)
    process.stdin.pipe(runner.stdin)
    runner.stdout.pipe(process.stdout)
    runner.stderr.pipe(process.stderr)
  } catch { report({ type: 'spawn_error' }, stop) }
})
if (!process.connected) stop()
