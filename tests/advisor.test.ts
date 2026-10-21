import { describe, expect, test } from 'claude-code/testing'

import {
  analyzePrompt,
  advisorReport,
  estimateCost,
  modelTier,
  sessionAdvisor,
  sessionCost,
} from '../hooks/advisor'
import * as M from '../hooks/model'

describe('advisor', () => {
  test('modelTier identifies opus, sonnet, and haiku models', () => {
    expect(modelTier('claude-3-5-sonnet-20241022')).toBe('sonnet')
    expect(modelTier('claude-3-opus-20240229')).toBe('opus')
    expect(modelTier('claude-3-5-haiku-20241022')).toBe('haiku')
    expect(modelTier(undefined)).toBe('sonnet')
  })

  test('estimateCost computes actual cost and prompt cache savings', () => {
    const g = M.emptyGraph(0)
    M.spawn(g, { id: 'a1', type: 'Code', description: 'Write code', prompt: 'test' }, 0)
    const a = g.agents.a1!
    a.model = 'claude-3-5-sonnet-20241022'
    a.inTok = 100_000
    a.cacheTok = 80_000 // 80k cached at $0.30/M, 20k uncached at $3.00/M
    a.outTok = 5_000 // 5k out at $15.00/M

    const cost = estimateCost(a)
    // uncached input: 20k * 3 / 1M = $0.06
    // cached input: 80k * 0.3 / 1M = $0.024
    // output: 5k * 15 / 1M = $0.075
    // actual = 0.06 + 0.024 + 0.075 = $0.159
    // withoutCache = 100k * 3 / 1M + 0.075 = $0.375
    // saved = 0.375 - 0.159 = $0.216
    expect(Number(cost.actual.toFixed(3))).toBe(0.159)
    expect(Number(cost.saved.toFixed(3))).toBe(0.216)
    expect(Number(cost.withoutCache.toFixed(3))).toBe(0.375)
  })

  test('analyzePrompt detects file paths, constraints, and vague exploratory traps', () => {
    const unconstrained = analyzePrompt('Find all bugs in the codebase and fix them')
    expect(unconstrained.hasPath).toBe(false)
    expect(unconstrained.isVague).toBe(true)

    const constrained = analyzePrompt('Focus ONLY on src/auth/login.ts. Do not modify other files.')
    expect(constrained.hasPath).toBe(true)
    expect(constrained.hasConstraint).toBe(true)
    expect(constrained.isVague).toBe(false)
  })

  test('advisorReport warns on unconstrained prompts and rewards high cache hits', () => {
    const g = M.emptyGraph(0)
    M.spawn(g, { id: 'a1', type: 'Explore', description: 'explore everything', prompt: 'check all files' }, 0)
    const a = g.agents.a1!
    a.inTok = 300_000
    a.cacheTok = 50_000 // low cache rate < 0.5
    a.outTok = 2_000

    const rep = advisorReport(a, g)
    expect(rep.score).toBeLessThan(75)
    expect(rep.items.some(i => i.id === 'unconstrained-prompt')).toBe(true)
    expect(rep.items.some(i => i.id === 'low-cache-rate')).toBe(true)

    // Well-scoped agent
    M.spawn(g, { id: 'a2', type: 'Code', description: 'Fix types in src/types.ts', prompt: 'only edit `src/types.ts`' }, 0)
    const a2 = g.agents.a2!
    a2.inTok = 300_000
    a2.cacheTok = 280_000 // >85% cache rate
    a2.outTok = 1_000

    const rep2 = advisorReport(a2, g)
    expect(rep2.score).toBeGreaterThanOrEqual(85)
    expect(rep2.items.some(i => i.id === 'well-scoped-prompt')).toBe(true)
    expect(rep2.items.some(i => i.id === 'high-cache-rate')).toBe(true)
  })

  test('sessionAdvisor aggregates overall metrics and top recommendations', () => {
    const g = M.emptyGraph(0)
    M.spawn(g, { id: 'a1', type: 'Explore', description: 'look around', prompt: 'find and fix' }, 0)
    const a = g.agents.a1!
    a.inTok = 150_000
    a.cacheTok = 120_000
    a.outTok = 4_000

    const s = sessionAdvisor(g)
    expect(s.totalCost).toBeGreaterThan(0)
    expect(s.totalTokens).toBe(154_000)
    expect(s.cacheRate).toBeGreaterThan(0.7)
    expect(Array.isArray(s.topSuggestions)).toBe(true)

    const c = sessionCost(g)
    expect(c.total).toBeGreaterThan(0)
    expect(c.saved).toBeGreaterThan(0)
    expect(c.full).toBeGreaterThan(c.total)
  })

  test('advisorReport warns when an agent is stuck repeating the same tool call', () => {
    const g = M.emptyGraph(0)
    M.spawn(g, { id: 'a1', type: 'Code', description: 'Fix build in src/build.ts', prompt: 'only edit `src/build.ts`' }, 0)
    for (let i = 0; i < 4; i += 1) {
      M.toolStart(g, 'a1', 'Bash: build', 100 + i * 10, 'Bash', 'npm run build')
      M.toolEnd(g, 'a1', 105 + i * 10)
    }
    const rep = advisorReport(g.agents.a1!, g)
    const loopItem = rep.items.find(i => i.id === 'repeated-tool-call')
    expect(loopItem).toBeDefined()
    expect(loopItem?.severity).toBe('warning')
    expect(loopItem?.title).toContain('4x')
  })
})
