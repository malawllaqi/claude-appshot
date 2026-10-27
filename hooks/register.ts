import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  type ActiveSession,
  type AppshotMeta,
  details,
  isCaptureId,
  label,
  marker,
  markerIds,
  mayClaim,
} from './core'

// The Hammerspoon helper (appshot.lua) renames each finished capture into
// inbox/<id>/ (meta.json, shot.png, text.txt). Every session with this mod
// polls the inbox; the one the person used last claims a capture by moving it
// to claimed/<id>/, and puts a marker in its prompt box that prompt.submit
// expands into the screenshot path and the window text.

type Paths = { root: string; inbox: string; claimed: string; expired: string; active: string }

const DEFAULT_QUESTION = 'Here is an appshot of a window on my Mac. Look at it and tell me what matters.'
const WAIT_FOR_HELPER_MS = 8000

let paths: Paths | undefined
let sessionId = ''
let timer: Timer | undefined
let isPolling = false
// Set by /appshot: the question to send with the capture it asked for.
let pending: { question: string | undefined; since: number } | undefined

async function resolvePaths($: EngineInterface): Promise<Paths> {
  const home = (await $.env.get('HOME')) ?? ''
  const root = `${home}/Library/Application Support/AppShot`
  return {
    root,
    inbox: `${root}/inbox`,
    claimed: `${root}/claimed`,
    expired: `${root}/expired`,
    active: `${root}/active-session.json`,
  }
}

async function markActive($: EngineInterface): Promise<void> {
  if (!paths || !sessionId) return
  const entry: ActiveSession = { sessionId, at: await $.clock.now() }
  await $.fs.write(paths.active, JSON.stringify(entry)).catch(() => undefined)
}

async function readActive($: EngineInterface, p: Paths): Promise<ActiveSession | undefined> {
  try {
    return JSON.parse(await $.fs.read(p.active)) as ActiveSession
  } catch {
    return undefined
  }
}

async function readMeta($: EngineInterface, dir: string): Promise<AppshotMeta | undefined> {
  try {
    return JSON.parse(await $.fs.read(`${dir}/meta.json`)) as AppshotMeta
  } catch {
    return undefined
  }
}

async function readText($: EngineInterface, dir: string, meta: AppshotMeta): Promise<string> {
  return $.fs.read(`${dir}/${meta.text ?? 'text.txt'}`).catch(() => '')
}

async function deliver($: EngineInterface, p: Paths, meta: AppshotMeta): Promise<void> {
  const dir = `${p.claimed}/${meta.id}`
  const asked = pending
  pending = undefined

  if (asked?.question === undefined) {
    const box = await $.prompt.read()
    const gap = box.text && !/\s$/.test(box.text) ? ' ' : ''
    const filled = await $.prompt.fill({ text: `${gap}${marker(meta)} `, mode: 'append' })
    if (filled.isFilled) {
      $.ui.toast(`Appshot attached: ${label(meta)}. Type your question and send.`)
      return
    }
  }

  // A question came with /appshot, or there is no prompt box to fill: send it now.
  const text = await readText($, dir, meta)
  await $.prompt.submit({
    text: `${asked?.question ?? DEFAULT_QUESTION}\n\n${details(meta, dir, text)}`,
    asUser: true,
  })
}

async function poll($: EngineInterface): Promise<void> {
  const p = paths
  if (!p || isPolling) return
  isPolling = true
  try {
    const now = await $.clock.now()
    if (pending && now - pending.since > WAIT_FOR_HELPER_MS) {
      pending = undefined
      $.ui.toast(
        'No appshot arrived. Is Hammerspoon running appshot.lua, with Screen Recording and Accessibility allowed?',
      )
    }

    const entries = await $.fs.list(p.inbox).catch(() => [])
    const ids = entries
      .filter(entry => entry.kind === 'dir' && isCaptureId(entry.name))
      .map(entry => entry.name)
      .sort()
    if (ids.length === 0) return

    const active = await readActive($, p)
    for (const id of ids) {
      const meta = await readMeta($, `${p.inbox}/${id}`)
      if (!meta) continue
      const verdict = mayClaim(meta, sessionId, active, now)
      if (verdict === 'wait') continue

      const target = verdict === 'stale' ? `${p.expired}/${id}` : `${p.claimed}/${id}`
      // One rename: when two sessions race, the second finds the source gone.
      const moved = await $.process.run(['/bin/mv', `${p.inbox}/${id}`, target])
      if (moved.exitCode !== 0 || verdict === 'stale') continue
      await deliver($, p, meta)
    }
  } catch (error) {
    $.ui.log(`appshot: poll failed: ${String(error)}`, { to: 'debug' })
  } finally {
    isPolling = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'appshot',
      description: 'Attach the window behind Claude (image + text) as an appshot',
      argumentHint: '[question]',
    })

    paths = await resolvePaths($)
    sessionId = await $.session.id()
    await $.process.run(['/bin/mkdir', '-p', paths.inbox, paths.claimed, paths.expired])
    if (e.isInteractive) await markActive($)

    timer?.cancel()
    timer = $.clock.every(1000, () => void poll($))

    return started
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = undefined
    return next(e)
  })

  // The session the person types in is the one the next appshot goes to.
  on('prompt.submit', async ($, e, next) => {
    await markActive($)
    const p = paths
    const ids = e.command ? [] : markerIds(e.text)
    if (!p || ids.length === 0) return next(e)

    const blocks: string[] = []
    for (const id of ids) {
      const dir = `${p.claimed}/${id}`
      const meta = await readMeta($, dir)
      if (meta) blocks.push(details(meta, dir, await readText($, dir, meta)))
    }
    return next(blocks.length ? { ...e, context: [...(e.context ?? []), ...blocks] } : e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'appshot' }, async ($, e) => {
    await markActive($)
    const question = e.args.trim() || undefined
    const opened = await $.process.run(['/usr/bin/open', '-g', 'hammerspoon://appshot'])
    if (opened.exitCode !== 0) {
      return {
        text: `Could not reach Hammerspoon: ${opened.stderr.trim() || `exit ${opened.exitCode}`}. Install Hammerspoon and load appshot.lua from its init.lua.`,
        exitCode: 1,
      }
    }
    pending = { question, since: await $.clock.now() }
    return { text: 'Capturing the window behind Claude with Hammerspoon…' }
  })
}
