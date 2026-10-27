import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AttachedShots, PendingShot } from '../types'
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

const WAIT_FOR_HELPER_MS = 8000
// How often the inbox is listed: one directory read, cheap enough to do often.
const POLL_MS = 250
// The band keeps the newest captures only; an older one drops off unsent.
const MAX_PENDING = 3
// Thumbnail sizes: a JPEG for the remote surfaces' Svg, a PNG for the terminal.
const THUMB_SIDES = [480, 320, 200]
const THUMB_PNG_SIDE = 320
const SVG_LIMIT = 131072
const SHOWN_WIDTH = 168
// A sent message shows the captures it carried, a little smaller.
const SENT_WIDTH = 120
// How many sent messages keep their thumbnails; older ones draw as before.
const ATTACHED_KEPT = 10

const pending = atom({ plugin: 'appshot', key: 'pending' } as const, [] as PendingShot[])
const attached = atom({ plugin: 'appshot', key: 'attached' } as const, [] as AttachedShots)

let paths: Paths | undefined
let sessionId = ''
let timer: Timer | undefined
// The poll under way, if any: a prompt being sent waits for it, then claims.
let polling: Promise<void> | undefined
// Whether a window showed this session at the last poll: the session the
// person switches to becomes the one the next capture goes to.
let isShown = false
// The captures the prompt being sent carries, until its row is stored: the
// row's uuid is what the transcript draws it by.
let carrying: { texts: string[]; shots: PendingShot[] } | undefined
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

async function deliver($: EngineInterface, p: Paths, meta: AppshotMeta, isQuiet: boolean): Promise<void> {
  const dir = `${p.claimed}/${meta.id}`
  const asked = asking
  asking = undefined

  // `/appshot <question>` asked to send it now; nothing else ever sends a
  // message the person did not.
  if (asked?.question !== undefined) {
    const text = await readText($, dir, meta)
    // Not awaited: the submission runs this mod's own prompt.submit hook,
    // which waits for the poll that is delivering it.
    void $.prompt.submit({ text: `${asked.question}\n\n${details(meta, dir, text)}`, asUser: true })
    return
  }

  // The band waits for the next message sent; one claimed while that very
  // message is being sent goes with it, so no toast says otherwise.
  const shot = await makeThumbs($, dir, meta)
  await update($, pending, list =>
    [...list.filter(one => one.id !== shot.id), shot].slice(-MAX_PENDING),
  )
  if (!isQuiet) $.ui.toast(`Appshot attached: ${shot.label}. It goes with your next message.`)
}

/**
 * Claims what waits in the inbox for this session. Only a session a window
 * shows claims on its own; `isInUse` (a prompt being sent here) claims too, so
 * a session the desktop app starts with its first message gets the capture
 * taken while it was on screen but not yet running.
 */
async function poll($: EngineInterface, isInUse = false): Promise<void> {
  if (polling) {
    if (!isInUse) return polling
    await polling
  }
  polling = claimWaiting($, isInUse).finally(() => {
    polling = undefined
  })
  return polling
}

async function claimWaiting($: EngineInterface, isInUse: boolean): Promise<void> {
  const p = paths
  if (!p) return
  try {
    const now = await $.clock.now()
    const shown = (await $.session.surfaces()).length > 0
    if (shown && !isShown) await markActive($)
    isShown = shown

    if (asking && now - asking.since > WAIT_FOR_HELPER_MS) {
      asking = undefined
      $.ui.toast(
        'No appshot arrived. Is Hammerspoon running appshot.lua, with Screen Recording and Accessibility allowed?',
      )
    }
    // A session nobody is looking at leaves captures for the one they are.
    if (!shown && !isInUse) return

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
      await deliver($, p, meta, isInUse)
    }
  } catch (error) {
    $.ui.log(`appshot: poll failed: ${String(error)}`, { to: 'debug' })
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
    // A session just opened is the one the person is in.
    await markActive($)

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
    const isPersons = !e.command && !e.isMeta && e.origin.kind !== 'plugin'
    if (isPersons) await poll($, true)
    const shots = isPersons ? await read($, pending) : []
    if (shots.length === 0) return next(e)

    const blocks: string[] = []
    for (const shot of shots) {
      const meta = await readMeta($, shot.dir)
      if (meta) blocks.push(details(meta, shot.dir, await readText($, shot.dir, meta)))
    }
    carrying = { texts: [e.text], shots }
    const sent = await next(blocks.length ? { ...e, context: [...(e.context ?? []), ...blocks] } : e)
    if (sent.drop !== undefined) {
      carrying = undefined
      return sent
    }
    carrying?.texts.push(sent.text)
    const ids = new Set(shots.map(shot => shot.id))
    await update($, pending, list => list.filter(one => !ids.has(one.id)))
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

  // The row that holds a prompt which carried captures: remember its uuid.
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    const stored = await next(e)
    const c = carrying
    if (!c || stored.deny !== undefined || e.message.type !== 'user' || e.message.isMeta) return stored
    const texts = e.message.content.flatMap(block =>
      block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
    )
    if (!texts.some(text => c.texts.some(sent => sent !== '' && text.includes(sent)))) return stored
    carrying = undefined
    const entry = { uuid: stored.uuid, shots: c.shots }
    // Only the thumbnails are at stake here: the row is stored either way.
    await update($, attached, list =>
      [...list.filter(one => one.uuid !== entry.uuid), entry].slice(-ATTACHED_KEPT),
    ).catch(() => undefined)
    return stored
  }).catch(($, e, next) => next(e))

  // A sent message that carried captures shows their thumbnails under it.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const entry = (await read($, attached)).find(one => one.uuid === e.requestId)
    const row = await next(e)
    if (!entry) return row

    if (e.surface === 'terminal') {
      const { Box, Image, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {row}
          <Box flexDirection="row" gap={1}>
            {entry.shots.map(shot =>
              shot.thumbPng ? (
                <Image
                  key={`sent-${shot.id}`}
                  source={{ file: shot.thumbPng, format: 'png' }}
                  columns={14}
                  rows={5}
                  alt={`Appshot: ${shot.label}`}
                />
              ) : (
                <Text dimColor>Appshot: {shot.label}</Text>
              ),
            )}
          </Box>
        </Box>
      )
    }

    const { Box, Svg, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" gap={1}>
        {row}
        <Box flexDirection="row" gap={1}>
          {entry.shots.map(shot =>
            shot.thumbJpeg ? (
              <Svg
                source={thumbSvg(shot.thumbJpeg, shot.thumbWidth, shot.thumbHeight)}
                alt={`Appshot: ${shot.label}`}
                width={SENT_WIDTH}
                height={Math.round((SENT_WIDTH * shot.thumbHeight) / shot.thumbWidth)}
              />
            ) : (
              <Text dimColor>Appshot: {shot.label}</Text>
            ),
          )}
        </Box>
      </Box>
    )
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
            <Box key={`shot-${shot.id}`} flexDirection="row" alignItems="flex-start">
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
              {/* A terminal image hides text drawn over it, so the x sits beside its corner. */}
              <Button key={`remove-${shot.id}`} label="✕" plain onPress={remove(shot.id)} />
            </Box>
          ))}
        </Box>
      )
    }

    const { Box, Button, Svg, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={2}>
        {shots.map(shot => (
          <Box key={`shot-${shot.id}`} position="relative">
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
            {/* The close control in the thumbnail's top-right corner. */}
            <Box position="absolute" top={0} right={0}>
              <Button key={`remove-${shot.id}`} label="✕" role="dismiss" plain onPress={remove(shot.id)} />
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
