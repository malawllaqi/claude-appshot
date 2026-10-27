import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { PendingShot } from '../types'
import {
  type ActiveSession,
  type AppshotMeta,
  details,
  isCaptureId,
  label,
  mayClaim,
  thumbSize,
  thumbSvg,
} from './core'

// The Hammerspoon helper (appshot.lua) renames each finished capture into
// inbox/<id>/ (meta.json, shot.png, text.txt). Every session with this mod
// polls the inbox; the one the person used last claims a capture by moving it
// to claimed/<id>/ and shows its thumbnail above the prompt box. The next
// prompt the person sends carries every shown capture: its screenshot path
// and window text, as context the model reads.

type Paths = { root: string; inbox: string; claimed: string; expired: string; active: string }

const DEFAULT_QUESTION = 'Here is an appshot of a window on my Mac. Look at it and tell me what matters.'
const WAIT_FOR_HELPER_MS = 8000
// How often the inbox is listed: one directory read, cheap enough to do often.
const POLL_MS = 250
// Thumbnail sizes: a JPEG for the remote surfaces' Svg, a PNG for the terminal.
const THUMB_SIDES = [480, 320, 200]
const THUMB_PNG_SIDE = 320
const SVG_LIMIT = 131072
const SHOWN_WIDTH = 168

const pending = atom({ plugin: 'appshot', key: 'pending' } as const, [] as PendingShot[])

let paths: Paths | undefined
let sessionId = ''
let timer: Timer | undefined
let isPolling = false
// Set by /appshot: the question to send with the capture it asked for.
let asking: { question: string | undefined; since: number } | undefined

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

/** Makes the capture's thumbnails with sips; a missing screenshot makes none. */
async function makeThumbs($: EngineInterface, dir: string, meta: AppshotMeta): Promise<PendingShot> {
  const shot: PendingShot = { id: meta.id, label: label(meta), dir, thumbWidth: 16, thumbHeight: 10 }
  if (!meta.image) return shot
  const source = `${dir}/${meta.image}`

  // The smallest side that still fits the Svg's length limit, largest first.
  for (const side of THUMB_SIDES) {
    const out = `${dir}/thumb.jpg`
    const made = await $.process.run([
      '/usr/bin/sips', '-Z', String(side), '-s', 'format', 'jpeg', '-s', 'formatOptions', '60',
      source, '--out', out,
    ])
    if (made.exitCode !== 0) break
    const { base64 } = await $.fs.read(out, { as: 'bytes' })
    const size = thumbSize(meta, side)
    if (thumbSvg(base64, size.width, size.height).length <= SVG_LIMIT) {
      shot.thumbJpeg = base64
      shot.thumbWidth = size.width
      shot.thumbHeight = size.height
      break
    }
  }

  const png = `${dir}/thumb.png`
  const madePng = await $.process.run([
    '/usr/bin/sips', '-Z', String(THUMB_PNG_SIDE), '-s', 'format', 'png', source, '--out', png,
  ])
  if (madePng.exitCode === 0) shot.thumbPng = png
  return shot
}

async function deliver($: EngineInterface, p: Paths, meta: AppshotMeta): Promise<void> {
  const dir = `${p.claimed}/${meta.id}`
  const asked = asking
  asking = undefined
  const hasPrompt = (await $.session.surfaces()).length > 0

  if (asked?.question === undefined && hasPrompt) {
    const shot = await makeThumbs($, dir, meta)
    await update($, pending, list => [...list.filter(one => one.id !== shot.id), shot])
    $.ui.toast(`Appshot attached: ${shot.label}. It goes with your next message.`)
    return
  }

  // A question came with /appshot, or no surface shows a prompt box: send it now.
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
    if (asking && now - asking.since > WAIT_FOR_HELPER_MS) {
      asking = undefined
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
    timer = $.clock.every(POLL_MS, () => void poll($))

    return started
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = undefined
    return next(e)
  })

  // The session the person types in is the one the next appshot goes to, and
  // the prompt they send carries the captures shown above the box.
  on('prompt.submit', async ($, e, next) => {
    await markActive($)
    const shots = e.command || e.isMeta ? [] : await read($, pending)
    if (shots.length === 0) return next(e)

    const blocks: string[] = []
    for (const shot of shots) {
      const meta = await readMeta($, shot.dir)
      if (meta) blocks.push(details(meta, shot.dir, await readText($, shot.dir, meta)))
    }
    const sent = await next(blocks.length ? { ...e, context: [...(e.context ?? []), ...blocks] } : e)
    if (sent.drop === undefined) {
      const ids = new Set(shots.map(shot => shot.id))
      await update($, pending, list => list.filter(one => !ids.has(one.id)))
    }
    return sent
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
    asking = { question, since: await $.clock.now() }
    return { text: 'Capturing the window behind Claude with Hammerspoon…' }
  })

  // The captures that go with the next message: a thumbnail each, and a way to drop one.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shots = await read($, pending)
    if (shots.length === 0 || e.props.hasSurvey) return next(e)
    const remove = (id: string) => () => update($, pending, list => list.filter(one => one.id !== id))

    if (e.surface === 'terminal') {
      const { Box, Button, Image, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" gap={2}>
          {shots.map(shot => (
            <Box key={`shot-${shot.id}`} flexDirection="column">
              {shot.thumbPng ? (
                <Image
                  key={`img-${shot.id}`}
                  source={{ file: shot.thumbPng, format: 'png' }}
                  columns={18}
                  rows={6}
                  alt={`Appshot: ${shot.label}`}
                />
              ) : (
                <Text>Appshot: {shot.label}</Text>
              )}
              <Button key={`remove-${shot.id}`} label="Remove" onPress={remove(shot.id)} />
            </Box>
          ))}
        </Box>
      )
    }

    const { Box, Button, Svg, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={2}>
        {shots.map(shot => (
          <Box key={`shot-${shot.id}`} flexDirection="column" gap={1}>
            {shot.thumbJpeg ? (
              <Svg
                source={thumbSvg(shot.thumbJpeg, shot.thumbWidth, shot.thumbHeight)}
                alt={`Appshot: ${shot.label}`}
                width={SHOWN_WIDTH}
                height={Math.round((SHOWN_WIDTH * shot.thumbHeight) / shot.thumbWidth)}
              />
            ) : (
              <Text>Appshot: {shot.label}</Text>
            )}
            <Button key={`remove-${shot.id}`} label="Remove" onPress={remove(shot.id)} />
          </Box>
        ))}
      </Box>
    )
  })
}
