import { describe, expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'agent-flow',
  props: {
    title: 'Agent Flow',
    isFocused: false,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
  viewport: { columns: 140, rows: 50, isFullscreen: true },
} as const

/** The characters a terminal Raster in the drawing shows, row by row (or the tree's JSON when there is none). */
function shown(drawn: unknown): string {
  const json = JSON.stringify(drawn)
  const m = /"type":"Raster","props":\{[^}]*"columns":(\d+),"rows":(\d+),"cells":"([^"]+)"/.exec(json)
  if (!m) return json
  const columns = Number(m[1])
  const bin = atob(m[3] ?? '')
  const out: string[] = []
  for (let i = 0; i + 12 <= bin.length; i += 12) {
    const cp = bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8) | (bin.charCodeAt(i + 2) << 16)
    out.push(cp === 0x2580 ? ' ' : String.fromCodePoint(cp))
    if (out.length % (columns + 1) === columns) out.push('\n')
  }
  return json + out.join('')
}

describe('register', () => {
  test('a spawned agent streams, reports back, and shows on the terminal and desktop', async ($, on) => {
    const clock = mock.clock(on)
    const opened: string[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.open', ($, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true as const } }
    })
    on('agent.spawn', () => ({ model: 'claude-haiku', agentId: 'agent-1' }))
    on('turn.step', async function* () {
      yield { kind: 'text', index: 0, text: 'Found the auth middleware in src/auth.ts' }
      return {
        turnId: 't1',
        index: 0,
        answer: 'Found the auth middleware in src/auth.ts',
        toolUses: [],
        stopReason: 'end_turn',
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          model: 'claude-haiku',
        },
      }
    })
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.agent.spawn({
      tool_use_id: 'toolu_1',
      prompt: 'Find where auth happens',
      description: 'Find auth code',
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus',
      background: false,
      fork: false,
    })
    expect(opened).toEqual(['agent-flow'])

    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku', messageCount: 1, agentId: 'agent-1' })
    for await (const _ of stream) {
      // read it through
    }
    await $.turn.complete({
      answer: 'Auth lives in src/auth.ts',
      durationMs: 1000,
      isAborted: false,
      turnId: 't1',
      agentId: 'agent-1',
      reason: 'answer',
    })
    await clock.advance(400)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'agent-flow', surface, ...PANE })
      const drawn = shown(await ui.drawn())
      if (surface === 'terminal') expect(drawn).toContain('"type":"Raster"')
      expect(drawn).toContain('Explore #1')
      expect(drawn).toContain('Find auth code')
      expect(drawn).toContain('1.2k')
      expect(drawn).not.toContain('DATA WIRE')
      await ui.press({ key: 'view' })
      expect(JSON.stringify(await ui.drawn())).toContain('DATA WIRE')
      await ui.press({ key: 'view' })
      expect(JSON.stringify(await ui.drawn())).not.toContain('DATA WIRE')
      await ui.unmount()
    }
  })

  test('/agent-flow opens the pane and reset clears the map', async ($, on) => {
    mock.clock(on)
    const opened: string[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.open', ($, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true as const } }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const { text } = await $.command.run({ command: 'agent-flow', args: 'reset',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })
    expect(text).toContain('cleared')
    expect(opened).toEqual(['agent-flow'])
  })

  test('streaming tokens do not rebuild the desktop SVG; a packet does', async ($, on) => {
    const clock = mock.clock(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    on('agent.spawn', () => ({ model: 'claude-haiku', agentId: 'agent-1' }))
    on('turn.step', async function* () {
      for (let k = 0; k < 20; k += 1) yield { kind: 'text', index: 0, text: 'streaming words '.repeat(5) }
      return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    on('session.send', () => ({ isDelivered: true as const }))

    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.agent.spawn({
      tool_use_id: 'toolu_1',
      prompt: 'Find where auth happens',
      description: 'Find auth code',
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus',
      background: false,
      fork: false,
    })
    await clock.advance(200)
    const ui = await $.ui.mount({ plugin: 'agent-flow', surface: 'desktop', ...PANE })
    const before = JSON.stringify(await ui.drawn())

    for (let k = 0; k < 3; k += 1) {
      for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku', messageCount: 1, agentId: 'agent-1' })) {
        // stream it through
      }
      await clock.advance(200)
    }
    expect(JSON.stringify(await ui.drawn())).toBe(before)

    await $.session.send({ to: 'main', text: 'found it', origin: { kind: 'model' }, agentId: 'agent-1' })
    await clock.advance(200)
    expect(JSON.stringify(await ui.drawn())).not.toBe(before)
    await ui.unmount()
  })

  for (const [name, env, kind] of [
    ['Ghostty gets real-pixel orbs (a PNG Image)', { TERM_PROGRAM: 'ghostty' }, 'Image'],
    ['iTerm2 falls back to the Raster orbs', { TERM_PROGRAM: 'iTerm.app' }, 'Raster'],
  ] as const) {
    test(name, async ($, on) => {
      mock.clock(on)
      mock.env(on, env)
      on('session.start', ($, e) => ({ cwd: e.cwd }))
      on('command.register', ($, e) => ({ value: { command: e.name } }))
      on('ui.open', () => ({ value: { isPlaced: true as const } }))
      await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
      const ui = await $.ui.mount({ plugin: 'agent-flow', surface: 'terminal', ...PANE })
      const drawn = JSON.stringify(await ui.drawn())
      expect(drawn).toContain(`"type":"${kind}"`)
      if (kind === 'Image') {
        const m = /"png":"([^"]+)"/.exec(drawn)
        expect(m).not.toBeNull()
        expect(atob(m?.[1] ?? '').slice(1, 4)).toBe('PNG')
      }
      await ui.unmount()
    })
  }

  test('/agent-flow web demo writes a demo copy of the page and opens it', async ($, on) => {
    mock.clock(on)
    mock.env(on, { HOME: '/home/kat' })
    mock.store(on)
    const files: Record<string, string> = {}
    const ran: string[][] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    on('fs.read', ($, e) => ({ value: files[e.path] ?? '<!doctype html><html><head><title>Agent Flow</title></head></html>' }))
    on('fs.write', ($, e) => {
      files[e.path] = e.text
      return { value: undefined }
    })
    on('process.run', ($, e) => {
      ran.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const { text } = await $.command.run({
      command: 'agent-flow',
      args: 'web demo',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })
    expect(text).toContain('demo run in your browser')
    expect(files['/home/kat/.claude/agent-flow/demo.html']).toContain('window.__AF_DEMO = true')
    expect(ran[0]).toEqual(['open', '/home/kat/.claude/agent-flow/demo.html'])
  })

  test('/agent-flow web keeps state.js live and writes each packet in full, and each context', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/home/kat' })
    mock.store(on)
    const files: Record<string, string> = {}
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    on('fs.read', () => ({ value: '<!doctype html><html><head></head></html>' }))
    on('fs.write', ($, e) => {
      files[e.path] = e.text
      return { value: undefined }
    })
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('agent.spawn', () => ({ model: 'claude-haiku', agentId: 'agent-1' }))
    on('session.messages', ($, e) => ({
      value:
        e.agentId === 'agent-1'
          ? [
              { role: 'user' as const, text: 'Find where auth happens. '.repeat(40), toolUses: [] },
              { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: { file_path: '/w/src/auth.ts' } }] },
              { role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: 'u1', text: 'export function auth() {}', isError: false }] },
            ]
          : [],
    }))
    on('turn.step', async function* () {
      yield { kind: 'text', index: 0, text: 'looking' }
      return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.command.run({ command: 'agent-flow', args: 'web', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    const prompt = 'Find where auth happens. '.repeat(40)
    await $.agent.spawn({
      tool_use_id: 'toolu_1',
      prompt,
      description: 'Find auth code',
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus',
      background: false,
      fork: false,
    })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku', messageCount: 1, agentId: 'agent-1' })) {
      // stream it through
    }
    await clock.advance(3000)
    // each session writes its own folder, so two sessions never overwrite each other's map
    const dir = Object.keys(files).find(f => /\/\.claude\/agent-flow\/s\/[^/]+\/index\.html$/.test(f))?.replace(/index\.html$/, '') ?? ''
    expect(dir).not.toBe('')
    // one dashboard for all sessions; the session's own link opens its tab
    expect(files['/home/kat/.claude/agent-flow/index.html']).toContain('<head>')
    expect(files[`${dir}index.html`]).toContain("index.html#s=")
    const list = files['/home/kat/.claude/agent-flow/sessions.js'] ?? ''
    expect(list).toContain('"project":"work"')
    const meta = files[`${dir}meta.js`] ?? ''
    expect(meta).toContain('"state":"running"')
    expect(meta).toContain('"running":1')
    const state = files[`${dir}state.js`] ?? ''
    const payload = JSON.parse(state.slice(state.indexOf('(') + 1, state.lastIndexOf(')')))
    expect(payload.v).toBe(2)
    expect(payload.graph.agents['agent-1'].label).toBe('Explore #1')

    const packets = files[`${dir}packets.js`] ?? ''
    const pk = JSON.parse(packets.slice(packets.indexOf('(') + 1, packets.lastIndexOf(')')))
    expect(pk.items[0].kind).toBe('spawn')
    expect(pk.items[0].body).toBe(prompt) // the whole prompt, not the clipped preview the graph keeps
    expect(pk.items[0].meta['Agent type']).toBe('Explore')

    const ctx = files[`${dir}context.js`] ?? ''
    const cx = JSON.parse(ctx.slice(ctx.indexOf('(') + 1, ctx.lastIndexOf(')')))
    expect(Object.keys(cx.agents)).toContain('agent-1')
    const kinds = cx.agents['agent-1'].entries.map((x: { kind: string }) => x.kind)
    expect(kinds).toEqual(['prompt', 'call', 'result'])
    expect(cx.agents['agent-1'].entries[2].title).toBe('Result of Read src/auth.ts')
  })

  for (const [name, env, root, opener] of [
    ['Windows: the page under %USERPROFILE%\\.claude, opened with start', { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\kat' }, 'C:\\Users\\kat/.claude/agent-flow', ['cmd', '/d', '/c', 'start', '']],
    ['Ubuntu desktop: a visible ~/agent-flow (Snap browsers cannot read ~/.claude), opened with xdg-open', { HOME: '/home/kat', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, '/home/kat/agent-flow', ['xdg-open']],
    ['WSL: opened in the Windows browser', { HOME: '/home/kat', WSL_DISTRO_NAME: 'Ubuntu' }, '/home/kat/.claude/agent-flow', ['wslview']],
    ['AGENT_FLOW_DIR moves it anywhere', { HOME: '/home/kat', XDG_CURRENT_DESKTOP: 'KDE', AGENT_FLOW_DIR: '/data/af/' }, '/data/af', ['xdg-open']],
  ] as const) {
    test(name, async ($, on) => {
      mock.clock(on)
      mock.env(on, env)
      mock.store(on)
      const files: Record<string, string> = {}
      const ran: string[][] = []
      on('session.start', ($, e) => ({ cwd: e.cwd }))
      on('command.register', ($, e) => ({ value: { command: e.name } }))
      on('ui.open', () => ({ value: { isPlaced: true as const } }))
      on('fs.read', ($, e) => ({ value: files[e.path] ?? '<!doctype html><html><head></head></html>' }))
      on('fs.write', ($, e) => {
        files[e.path] = e.text
        return { value: undefined }
      })
      on('process.run', ($, e) => {
        ran.push([...e.argv])
        return { value: { exitCode: 0, stdout: '\\\\wsl$\\Ubuntu\\x', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      })
      await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
      const { text } = await $.command.run({ command: 'agent-flow', args: 'web', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
      expect(text).toContain('open in your browser')
      // (this test host is Linux, so it reads a Windows path as relative and prefixes it; Windows does not)
      expect(Object.keys(files).some(f => f.endsWith(`${root}/index.html`))).toBe(true)
      const opened = ran.find(argv => argv[0] !== 'wslpath') ?? []
      expect(opened.slice(0, opener.length)).toEqual([...opener])
      if (env.OS) expect(opened.at(-1)).toMatch(/^C:\\Users\\kat\\\.claude\\agent-flow\\s\\[^\\/]+\\index\.html$/)
    })
  }
})
