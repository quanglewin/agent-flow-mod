import { describe, expect, test } from 'claude-code/testing'

import * as M from '../hooks/model'

describe('model', () => {
  test('a spawn adds a child under its parent with a task link sized from the prompt', async () => {
    const g = M.emptyGraph(0)
    M.spawn(g, { id: 'a1', type: 'Explore', description: 'Find auth code', prompt: 'x'.repeat(400) }, 10)
    const a = g.agents.a1
    expect(a?.parent).toBe(M.MAIN)
    expect(a?.label).toBe('Explore #1')
    expect(a?.role).toBe('Find auth code')
    expect(a?.status).toBe('running')
    expect(g.links).toHaveLength(1)
    expect(g.links[0]).toMatchObject({ from: M.MAIN, to: 'a1', kind: 'spawn', tokens: 100 })
  })

  test('streamed chunks and usage add up tokens; completion reports back to the parent', async () => {
    const g = M.emptyGraph(0)
    M.spawn(g, { id: 'a1', parent: M.MAIN, type: 'Plan', description: 'Plan it', prompt: 'p' }, 0)
    M.stepStart(g, 'a1', 'claude-haiku', 1000)
    M.stepChunk(g, 'a1', 4000, 1000) // a big buffered first chunk must not spike the rate
    M.stepChunk(g, 'a1', 400, 2000)
    expect(g.agents.a1?.liveOut).toBe(1100)
    expect(Math.round(g.agents.a1?.tps ?? 0)).toBe(100)
    expect(Math.round(g.agents.a1?.peakTps ?? 0)).toBe(100)
    M.stepEnd(
      g,
      'a1',
      { input_tokens: 50, output_tokens: 300, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, model: 'm' },
      3000,
    )
    expect(g.agents.a1).toMatchObject({ inTok: 1050, outTok: 300, cacheTok: 1000, steps: 1, liveOut: 0 })
    expect(Math.round(g.agents.a1?.peakTps ?? 0)).toBe(150) // the request's real rate, from usage
    expect(g.agents.a1?.tps).toBe(0) // nothing streams between requests
    M.stepStart(g, 'a1', 'claude-haiku', 3500)
    expect(g.agents.a1?.tps).toBe(0) // no stale rate while the next request waits
    M.turnComplete(g, 'a1', { answer: 'y'.repeat(80), reason: 'answer' }, 4000)
    expect(g.agents.a1?.status).toBe('done')
    expect(g.links.at(-1)).toMatchObject({ from: 'a1', to: M.MAIN, kind: 'report', tokens: 20 })
  })

  test('nested agents come in tree order with depth, and messages resolve names', async () => {
    const g = M.emptyGraph(0)
    M.spawn(g, { id: 'a', type: 'general-purpose', description: 'lead', prompt: 'p', name: 'lead' }, 0)
    M.spawn(g, { id: 'b', parent: 'a', type: 'Explore', description: 'dig', prompt: 'p' }, 0)
    M.spawn(g, { id: 'c', type: 'Plan', description: 'plan', prompt: 'p', name: 'planner' }, 0)
    expect(M.treeOrder(g)).toEqual([
      { id: M.MAIN, depth: 0 },
      { id: 'a', depth: 1 },
      { id: 'b', depth: 2 },
      { id: 'c', depth: 1 },
    ])
    M.message(g, 'b', 'planner', 'here is what I found', 5)
    expect(g.links.at(-1)).toMatchObject({ from: 'b', to: 'c', kind: 'message', tokens: 5 })
  })

  test('formatting and tool summaries read well', async () => {
    expect(M.fmt(950)).toBe('950')
    expect(M.fmt(1234)).toBe('1.2k')
    expect(M.fmt(45_000)).toBe('45k')
    expect(M.fmt(2_400_000)).toBe('2.4M')
    expect(M.summarizeTool('Read', { file_path: '/a/b/c/d.ts' })).toBe('Read c/d.ts')
    expect(M.summarizeTool('Bash', { command: 'ls', description: 'List files' })).toBe('Bash: List files')
    expect(M.summarizeTool('mcp__jira__search', {})).toBe('jira · search')
  })

  test('a packet is in flight only from the moment it fires until it has landed', async () => {
    const g = M.emptyGraph(0)
    M.spawn(g, { id: 'a1', type: 'Explore', description: 'dig', prompt: 'p' }, 1000)
    expect(M.packets(g, 999)).toHaveLength(0)
    expect(M.packets(g, 1000)).toHaveLength(1)
    expect(M.packets(g, 1000 + M.PACKET_MS)[0]?.elapsed).toBe(M.PACKET_MS)
    expect(M.packets(g, 1000 + M.PACKET_MS + M.IMPACT_MS)).toHaveLength(0)
  })

  test('an agent whose turn starts before its spawn resolves still gets its real name and role', async () => {
    const g = M.emptyGraph(0)
    M.turnStart(g, 'x1', 5)
    expect(g.agents.x1?.label).toBe('agent #1')
    M.spawn(g, { id: 'x1', type: 'Explore', description: 'List hook files', prompt: 'p' }, 10)
    expect(g.agents.x1).toMatchObject({ label: 'Explore #1', type: 'Explore', role: 'List hook files' })
    expect(g.order).toEqual([M.MAIN, 'x1'])
  })

  test('the map keeps what a developer asks of an agent: its tools with timings, context, last activity and result', async () => {
    const g = M.emptyGraph(0)
    M.spawn(g, { id: 'a1', type: 'Explore', description: 'Map auth', prompt: 'p' }, 1000)
    M.toolStart(g, 'a1', 'Read src/auth.ts', 2000)
    M.toolEnd(g, 'a1', 2600)
    M.toolStart(g, 'a1', 'Grep ValidateToken', 3000)
    expect(g.agents.a1?.toolLog).toEqual([
      { at: 2000, end: 2600, text: 'Read src/auth.ts' },
      { at: 3000, text: 'Grep ValidateToken' },
    ])
    expect(g.agents.a1?.lastActiveAt).toBe(3000)
    M.stepStart(g, 'a1', 'm', 3100)
    M.stepEnd(g, 'a1', { input_tokens: 500, output_tokens: 40, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 1500 }, 3900)
    expect(g.agents.a1?.ctxTok).toBe(82_000)
    M.turnComplete(g, 'a1', { answer: 'Auth lives in src/auth.ts', reason: 'answer' }, 5000)
    expect(g.agents.a1).toMatchObject({ result: 'Auth lives in src/auth.ts', endedAt: 5000, lastActiveAt: 5000 })
    expect(g.agents.a1?.toolLog?.[1]?.end).toBe(5000) // a call still open when the agent ends is closed with it
    for (let k = 0; k < 40; k += 1) M.toolStart(g, 'a1', `t${k}`, 6000 + k)
    expect(g.agents.a1?.toolLog?.length).toBe(M.TOOL_LOG_MAX)
  })

  test('only messages between agents that are not parent and child open a standing channel', async () => {
    const g = M.emptyGraph(0)
    M.spawn(g, { id: 'a', type: 'Explore', description: 'x', prompt: 'p', name: 'scout' }, 0)
    M.spawn(g, { id: 'b', type: 'Plan', description: 'y', prompt: 'p', name: 'planner' }, 0)
    M.message(g, 'a', 'main', 'progress', 1)
    expect(g.channels ?? {}).toEqual({})
    M.message(g, 'a', 'planner', 'which endpoint?', 2)
    M.message(g, 'b', 'scout', 'POST /auth/refresh', 3)
    expect(Object.values(g.channels ?? {})).toEqual([{ a: 'a', b: 'b', count: 2, tokens: 9, last: 3 }])
  })

  test('a plan from TodoWrite or TaskCreate/TaskUpdate gives progress', async () => {
    const g = M.emptyGraph(0)
    M.setTodos(g, M.MAIN, [
      { content: 'Read code', status: 'completed', activeForm: 'Reading code' },
      { content: 'Fix bug', status: 'in_progress', activeForm: 'Fixing the bug' },
      { content: 'Run tests', status: 'pending', activeForm: 'Running tests' },
    ], 1)
    expect(M.todoProgress(g.agents[M.MAIN]!)).toEqual({ done: 1, total: 3, current: 'Fixing the bug' })
    M.spawn(g, { id: 'a', type: 'Explore', description: 'x', prompt: 'p' }, 0)
    M.taskCreate(g, 'a', '7', 'Map auth', 'Mapping auth', 2)
    M.taskCreate(g, 'a', '8', 'Report', undefined, 2)
    M.taskUpdate(g, '7', { status: 'completed' })
    M.taskUpdate(g, '8', { status: 'deleted' })
    expect(M.todoProgress(g.agents.a!)).toEqual({ done: 1, total: 1, current: undefined })
  })

  test("the main loop's turn has an end, so the page can say the work is done", async () => {
    const g = M.emptyGraph(0)
    M.turnStart(g, M.MAIN, 100)
    M.turnComplete(g, M.MAIN, { answer: 'ok', reason: 'answer' }, 900)
    expect(g.agents[M.MAIN]).toMatchObject({ status: 'idle', startedAt: 100, endedAt: 900 })
    M.turnStart(g, M.MAIN, 1000)
    expect(g.agents[M.MAIN]?.endedAt).toBeUndefined()
  })

  test("an agent the map missed the start of gets its real name from the engine's list", async () => {
    const g = M.emptyGraph(0)
    M.spawn(g, { id: 'a', type: 'Explore', description: 'x', prompt: 'p' }, 0)
    M.turnStart(g, 'z', 5)
    expect(g.agents.z?.label).toBe('agent #2')
    expect(M.adopt(g, 'z', { type: 'Explore', description: 'Scan configs', parentId: 'a' })).toBe(true)
    expect(g.agents.z).toMatchObject({ label: 'Explore #2', type: 'Explore', role: 'Scan configs', parent: 'a' })
    expect(M.adopt(g, 'z', { type: 'Plan', description: 'no' })).toBe(false) // only placeholders are renamed
  })

  test('a general-purpose agent is named by its task, since every such agent shares the type', async () => {
    const g = M.emptyGraph(0)
    M.spawn(g, { id: 'a', type: 'general-purpose', description: 'Write plan for sub-project 2a exporter', prompt: 'p' }, 0)
    M.spawn(g, { id: 'b', type: 'general-purpose', description: 'Write plan for sub-project 2a exporter', prompt: 'p' }, 0)
    M.spawn(g, { id: 'c', type: 'Explore', description: 'Map auth', prompt: 'p' }, 0)
    expect(g.agents.a?.label).toBe('Write plan for sub-project 2a…')
    expect(g.agents.b?.label).toBe('Write plan for sub-project 2a… #2')
    expect(g.agents.c?.label).toBe('Explore #1')
    expect(g.agents.a?.type).toBe('general-purpose') // the type still shows beside the name
  })

  test('a worktree an agent works in is not taken for a session of yours', async () => {
    expect(M.isAgentWorktree('/Users/me/work/shop/.claude/worktrees/agent-a91d1e826d89f3')).toBe(true)
    expect(M.isAgentWorktree('C:\\work\\shop\\.claude\\worktrees\\agent-1\\')).toBe(true)
    expect(M.isAgentWorktree('/Users/me/work/shop')).toBe(false)
    expect(M.projectName('/Users/me/work/shop/.claude/worktrees/agent-a91')).toBe('shop (worktree agent-a91)')
    expect(M.projectName('/Users/kat/work/web-app/')).toBe('web-app')
  })

  test('external process calls (python, node, etc.) spawn child process nodes and report back', async () => {
    const g = M.emptyGraph(0)
    expect(M.detectProcess('python script.py --arg 1')).toBe('python')
    expect(M.detectProcess('python3 scripts/model.py')).toBe('python')
    expect(M.detectProcess('node build.js')).toBe('node')
    expect(M.detectProcess('ls -la')).toBeUndefined()
    expect(M.processLabel('python3 /path/to/train.py --epochs 5', 'python')).toBe('python train.py')

    const procId = M.processStart(g, M.MAIN, 'python run_eval.py', 'Run evaluation', 100)
    expect(procId).toBeDefined()
    const proc = g.agents[procId!]
    expect(proc).toMatchObject({
      parent: M.MAIN,
      isProcess: true,
      status: 'running',
      role: 'Run evaluation',
    })
    expect(proc?.label).toContain('python run_eval.py')
    expect(g.links).toHaveLength(1)
    expect(g.links[0]).toMatchObject({ from: M.MAIN, to: procId, kind: 'spawn' })

    // Process nodes do not inflate the LLM agent count in totals or session summary
    expect(M.totals(g).agents).toBe(1) // only main
    expect(M.summary(g).agents).toBe(0) // no subagents

    M.processEnd(g, procId!, true, 'Evaluation succeeded: 98% accuracy', 500)
    expect(proc?.status).toBe('done')
    expect(proc?.endedAt).toBe(500)
    expect(proc?.result).toContain('Evaluation succeeded')
    expect(g.links.at(-1)).toMatchObject({ from: procId, to: M.MAIN, kind: 'report' })
  })
})
