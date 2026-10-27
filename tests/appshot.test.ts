import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { details, markerIds, mayClaim, marker, type AppshotMeta } from '../hooks/core'

const ROOT = '/h/Library/Application Support/AppShot'
const ID = '20261027-153012-ab12'
const NOW = Date.UTC(2026, 9, 27, 15, 30, 12)

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

// Stands for the host beneath the mod: files in memory, `mv` a rename of them.
function world(on: On, sessionId = 'me') {
  const files = new Map<string, string>()
  const fills: string[] = []
  const submits: { text: string; context?: readonly string[] }[] = []
  const opened: string[][] = []

  mock.env(on, { HOME: '/h' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sessionId }))
  on('command.register', () => ({ value: { command: 'appshot' } }))
  on('fs.write', (_, e) => (files.set(e.path, e.text), { value: undefined }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: `missing ${e.path}` } : { value: text }
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
      if (moving.length === 0) return { value: { exitCode: 1, stdout: '', stderr: 'no such file', isStdoutTruncated: false, isStderrTruncated: false } }
      for (const path of moving) {
        files.set(to + path.slice(from.length), files.get(path) as string)
        files.delete(path)
      }
    }
    if (cmd === '/usr/bin/open') opened.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.read', () => ({ value: { text: 'hey', cursor: 3 } }))
  on('prompt.fill', (_, e) => {
    fills.push(e.text)
    return { isFilled: true, text: `hey${e.text}`, cursor: 3 + e.text.length }
  })
  on('prompt.submit', (_, e) => {
    submits.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))

  const drop = (meta: AppshotMeta, text = 'Pro plan $20 per month') => {
    files.set(`${ROOT}/inbox/${meta.id}/meta.json`, JSON.stringify(meta))
    files.set(`${ROOT}/inbox/${meta.id}/text.txt`, text)
  }
  return { files, fills, submits, opened, drop }
}

describe('core', () => {
  test('the active session claims at once, others after the grace period', async () => {
    const active = { sessionId: 'other', at: NOW }
    expect(mayClaim(META, 'other', active, NOW + 100)).toBe('claim')
    expect(mayClaim(META, 'me', active, NOW + 100)).toBe('wait')
    expect(mayClaim(META, 'me', active, NOW + 5000)).toBe('claim')
    expect(mayClaim(META, 'me', undefined, NOW + 100)).toBe('claim')
    expect(mayClaim(META, 'me', active, NOW + 11 * 60 * 1000)).toBe('stale')
  })

  test('a marker round-trips to its id', async () => {
    const m = marker({ ...META, title: 'a ] tricky title' })
    expect(m.startsWith(`[appshot ${ID} · Safari`)).toBe(true)
    expect(markerIds(`look ${m} and ${m}`)).toEqual([ID])
  })

  test('details name the screenshot and carry the window text', async () => {
    const out = details(META, '/d', 'Pro plan $20 per month')
    expect(out).toContain('/d/shot.png')
    expect(out).toContain('URL: https://acme.test/pricing')
    expect(out).toContain('<window_text>\nPro plan $20 per month\n</window_text>')
  })
})

test('a capture in the inbox is claimed and put in the prompt box', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  w.drop(META)
  await clock.advance(1000)

  expect(w.fills).toEqual([` ${marker(META)} `])
  expect(w.files.has(`${ROOT}/claimed/${ID}/meta.json`)).toBe(true)
  expect(w.files.has(`${ROOT}/inbox/${ID}/meta.json`)).toBe(false)

  await $.prompt.submit({
    text: `why so expensive? ${marker(META)}`,
    wait: false,
    origin: { kind: 'composer' },
  })
  const sent = w.submits.at(-1)
  expect(sent?.context?.[0]).toContain(`${ROOT}/claimed/${ID}/shot.png`)
  expect(sent?.context?.[0]).toContain('Pro plan $20 per month')
})

test('another session that was used last gets the first claim', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  w.files.set(`${ROOT}/active-session.json`, JSON.stringify({ sessionId: 'other', at: NOW }))

  w.drop(META)
  await clock.advance(1000)
  expect(w.fills).toEqual([])

  await clock.advance(3000)
  expect(w.fills.length).toBe(1)
})

test('/appshot with a question asks Hammerspoon and sends the capture', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ran = await $.command.run({
    command: 'appshot',
    args: 'what does this error mean?',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(ran.text).toContain('Capturing')
  expect(w.opened).toEqual([['/usr/bin/open', '-g', 'hammerspoon://appshot']])

  w.drop(META, 'TypeError: x is undefined')
  await clock.advance(1000)
  const sent = w.submits.at(-1)
  expect(sent?.text.startsWith('what does this error mean?')).toBe(true)
  expect(sent?.text).toContain('TypeError: x is undefined')
  expect(w.fills).toEqual([])
})
