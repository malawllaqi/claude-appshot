import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { details, label, mayClaim, thumbSize, thumbSvg, type AppshotMeta } from '../hooks/core'

const ROOT = '/h/Library/Application Support/AppShot'
const ID = '20261027-153012-ab12'
const NOW = Date.UTC(2026, 9, 27, 15, 30, 12)
const JPEG = 'anBlZy1ieXRlcw=='

const META: AppshotMeta = {
  id: ID,
  capturedAt: NOW,
  app: 'Safari',
  bundleID: 'com.apple.Safari',
  title: 'Pricing — Acme',
  url: 'https://acme.test/pricing',
  image: 'shot.png',
  imageWidth: 2000,
  imageHeight: 1250,
  text: 'text.txt',
  textChars: 22,
}

const BAND = {
  plugin: 'appshot',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const ran = (exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

// Stands for the host beneath the mod: files in memory, `mv` a rename of
// them, `sips` writing a thumbnail.
function world(on: On, sessionId = 'me') {
  const files = new Map<string, string>()
  const submits: { text: string; context?: readonly string[] }[] = []
  const opened: string[][] = []

  mock.env(on, { HOME: '/h' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sessionId }))
  // No window shows the session while a capture arrives: the band must wait anyway.
  on('session.surfaces', () => ({ value: [] as const }))
  on('command.register', () => ({ value: { command: 'appshot' } }))
  on('fs.write', (_, e) => (files.set(e.path, e.text), { value: undefined }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) return { deny: `missing ${e.path}` }
    return { value: e.as === 'bytes' ? { base64: text } : text }
  })
  on('fs.list', (_, e) => {
    const names = new Set<string>()
    for (const path of files.keys()) {
      if (path.startsWith(`${e.path}/`)) names.add(path.slice(e.path.length + 1).split('/')[0] as string)
    }
    return {
      value: [...names].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
    }
  })
  on('process.run', (_, e) => {
    const [cmd, from, to] = e.argv
    if (cmd === '/bin/mv' && from && to) {
      const moving = [...files.keys()].filter(path => path.startsWith(`${from}/`))
      if (moving.length === 0) return ran(1, 'no such file')
      for (const path of moving) {
        files.set(to + path.slice(from.length), files.get(path) as string)
        files.delete(path)
      }
    }
    if (cmd === '/usr/bin/sips') files.set(e.argv.at(-1) as string, JPEG)
    if (cmd === '/usr/bin/open') opened.push([...e.argv])
    return ran()
  })
  on('prompt.submit', (_, e) => {
    submits.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  // The engine's own band, drawn when the mod has nothing to show.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const drop = (meta: AppshotMeta, text = 'Pro plan $20 per month') => {
    files.set(`${ROOT}/inbox/${meta.id}/meta.json`, JSON.stringify(meta))
    files.set(`${ROOT}/inbox/${meta.id}/text.txt`, text)
  }
  return { files, submits, opened, drop }
}

const submit = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } as const })

describe('core', () => {
  test('the active session claims at once, others after the grace period', async () => {
    const active = { sessionId: 'other', at: NOW }
    expect(mayClaim(META, 'other', active, NOW + 100)).toBe('claim')
    expect(mayClaim(META, 'me', active, NOW + 100)).toBe('wait')
    expect(mayClaim(META, 'me', active, NOW + 5000)).toBe('claim')
    expect(mayClaim(META, 'me', undefined, NOW + 100)).toBe('claim')
    expect(mayClaim(META, 'me', active, NOW + 11 * 60 * 1000)).toBe('stale')
  })

  test('a thumbnail keeps the capture shape and embeds the JPEG', async () => {
    expect(thumbSize(META, 480)).toEqual({ width: 480, height: 300 })
    const svg = thumbSvg(JPEG, 480, 300)
    expect(svg).toContain(`href="data:image/jpeg;base64,${JPEG}"`)
    expect(label(META)).toBe('Safari — Pricing — Acme')
  })

  test('details name the screenshot and carry the window text', async () => {
    const out = details(META, '/d', 'Pro plan $20 per month')
    expect(out).toContain('/d/shot.png')
    expect(out).toContain('URL: https://acme.test/pricing')
    expect(out).toContain('<window_text>\nPro plan $20 per month\n</window_text>')
  })
})

test('a capture shows as a thumbnail and goes with the next message', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  w.drop(META)
  await clock.advance(1000)
  expect(w.files.has(`${ROOT}/claimed/${ID}/meta.json`)).toBe(true)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const picture = await ui.find({ type: surface === 'desktop' ? 'Svg' : 'Image' })
    expect(picture?.props.alt).toBe(`Appshot: ${label(META)}`)
    expect(await ui.find({ type: 'Text', text: /appshot/i })).toBeUndefined()
    await ui.unmount()
  }

  await $.prompt.submit(submit('why so expensive?'))
  const sent = w.submits.at(-1)
  expect(sent?.text).toBe('why so expensive?')
  expect(sent?.context?.[0]).toContain(`${ROOT}/claimed/${ID}/shot.png`)
  expect(sent?.context?.[0]).toContain('Pro plan $20 per month')

  // Sent once: the band empties and the next message carries nothing.
  const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await after.find({ type: 'Svg' })).toBeUndefined()
  await after.unmount()
  await $.prompt.submit(submit('and now?'))
  expect(w.submits.at(-1)?.context).toBeUndefined()
})

test('the band keeps only the newest 3 captures', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ids = [1, 2, 3, 4, 5].map(n => `20261027-15301${n}-ab12`)
  for (const id of ids) {
    w.drop({ ...META, id, title: `Tab ${id}` })
    await clock.advance(250)
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  for (const id of ids.slice(0, 2)) expect(await ui.find({ key: `remove-${id}` })).toBeUndefined()
  for (const id of ids.slice(2)) expect(await ui.find({ key: `remove-${id}` })).toBeDefined()
  await ui.unmount()

  await $.prompt.submit(submit('which tabs?'))
  const context = w.submits.at(-1)?.context ?? []
  expect(context.length).toBe(3)
  expect(context.map(block => block.slice(8, 28))).toEqual(ids.slice(2))
})

test('the x on a thumbnail drops the capture before it is sent', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  w.drop(META)
  await clock.advance(1000)

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await terminal.find({ key: `remove-${ID}` }))?.props.label).toBe('✕')
  await terminal.unmount()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const x = await ui.find({ key: `remove-${ID}` })
  expect(x?.props.label).toBe('✕')
  expect(x?.props.role).toBe('dismiss')
  await ui.press({ key: `remove-${ID}` })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()

  await $.prompt.submit(submit('hello'))
  expect(w.submits.at(-1)?.context).toBeUndefined()
})

test('a capture waits in the band while no window shows the session', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })

  w.drop(META)
  await clock.advance(1000)
  expect(w.files.has(`${ROOT}/claimed/${ID}/meta.json`)).toBe(true)
  expect(w.submits).toEqual([])

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: `remove-${ID}` })).toBeDefined()
  await ui.unmount()
})

test('a scripted session sends a capture at once, with nobody to see the band', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })

  w.drop(META)
  await clock.advance(1000)
  const sent = w.submits.at(-1)
  expect(sent?.text.startsWith('Here is an appshot of a window on my Mac.')).toBe(true)
  expect(sent?.text).toContain('Pro plan $20 per month')
})

test('another session that was used last gets the first claim', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  w.files.set(`${ROOT}/active-session.json`, JSON.stringify({ sessionId: 'other', at: NOW }))

  w.drop(META)
  await clock.advance(1000)
  expect(w.files.has(`${ROOT}/inbox/${ID}/meta.json`)).toBe(true)

  await clock.advance(3000)
  expect(w.files.has(`${ROOT}/claimed/${ID}/meta.json`)).toBe(true)
})

test('/appshot with a question asks Hammerspoon and sends the capture', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const result = await $.command.run({
    command: 'appshot',
    args: 'what does this error mean?',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(result.text).toContain('Capturing')
  expect(w.opened).toEqual([['/usr/bin/open', '-g', 'hammerspoon://appshot']])

  w.drop(META, 'TypeError: x is undefined')
  await clock.advance(1000)
  const sent = w.submits.at(-1)
  expect(sent?.text.startsWith('what does this error mean?')).toBe(true)
  expect(sent?.text).toContain('TypeError: x is undefined')
})
