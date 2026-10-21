import type {
  AdvisorItem,
  AdvisorReport,
  AgentFlowAgent,
  AgentFlowGraph,
  SessionAdvisorReport,
} from '../types'
import { clip, detectLoop, fmt } from './model'

/** Model pricing per 1,000,000 tokens (USD). */
export const MODEL_PRICING: Record<string, { input: number; cacheRead: number; output: number }> = {
  opus: { input: 15.0, cacheRead: 1.5, output: 75.0 },
  sonnet: { input: 3.0, cacheRead: 0.3, output: 15.0 },
  haiku: { input: 0.8, cacheRead: 0.08, output: 4.0 },
}

export function modelTier(modelName?: string): 'opus' | 'sonnet' | 'haiku' {
  const m = String(modelName ?? '').toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('haiku')) return 'haiku'
  return 'sonnet'
}

export function estimateCost(a: AgentFlowAgent): { actual: number; saved: number; withoutCache: number } {
  const tier = modelTier(a.model)
  const rates = MODEL_PRICING[tier] ?? MODEL_PRICING.sonnet
  const uncached = Math.max(0, a.inTok - a.cacheTok)
  const cached = Math.min(a.inTok, a.cacheTok)
  const out = a.outTok + Math.round(a.liveOut || 0)

  const actual = (uncached * rates.input + cached * rates.cacheRead + out * rates.output) / 1_000_000
  const withoutCache = (a.inTok * rates.input + out * rates.output) / 1_000_000
  const saved = Math.max(0, withoutCache - actual)
  return { actual, saved, withoutCache }
}

export function sessionCost(g: AgentFlowGraph): { total: number; saved: number; full: number } {
  let total = 0
  let saved = 0
  let full = 0
  for (const id of g.order) {
    const a = g.agents[id]
    if (!a) continue
    const c = estimateCost(a)
    total += c.actual
    saved += c.saved
    full += c.withoutCache
  }
  return { total, saved, full }
}

const FILE_EXT_PATTERN = /\b\w+\.(?:ts|tsx|js|jsx|py|go|rs|json|md|ya?ml|html|css|cpp|c|h|sql|proto|sh)\b/i
const PATH_PATTERN = /(?:[A-Za-z]:)?[\\/][\w.-]+[\\/][\w.-]+/
const CODE_QUOTE_PATTERN = /`[^`]{2,}`/
const CONSTRAINT_WORDS = /\b(?:only|strictly|limit|focus\s+on|scope|do\s+not|dont|don't|never|restrict)\b/i
const VAGUE_WORDS = /\b(?:explore\s+everything|check\s+all|check\s+everything|find\s+and\s+fix|find\s+all|look\s+around|refactor\s+codebase|scan\s+the\s+whole|search\s+all)\b/i

export function analyzePrompt(text: string): {
  hasPath: boolean
  hasConstraint: boolean
  isVague: boolean
} {
  const s = String(text ?? '')
  const hasPath = FILE_EXT_PATTERN.test(s) || PATH_PATTERN.test(s) || CODE_QUOTE_PATTERN.test(s)
  const hasConstraint = CONSTRAINT_WORDS.test(s)
  const isVague = VAGUE_WORDS.test(s) || (s.split(/\s+/).length < 5 && !hasPath)
  return { hasPath, hasConstraint, isVague }
}

export function advisorReport(a: AgentFlowAgent, _g: AgentFlowGraph): AdvisorReport {
  const items: AdvisorItem[] = []
  let score = 100
  const cost = estimateCost(a)
  const cacheRate = a.inTok > 0 ? a.cacheTok / a.inTok : 1

  // 1. Prompt scope analysis (for non-main agents or main prompts)
  const promptText = a.task || a.role || ''
  if (promptText && !a.isProcess) {
    const pa = analyzePrompt(promptText)
    if (!pa.hasPath && !pa.hasConstraint) {
      score -= 25
      items.push({
        id: 'unconstrained-prompt',
        severity: 'warning',
        title: 'Prompt lacks file or path constraints',
        summary: 'Without explicit path boundaries, agents explore broadly using Glob/Grep and read files unnecessarily.',
        detail: `The task "${clip(promptText, 80)}" does not specify target directories or files.`,
        snippet: `Focus ONLY on <target_file_or_dir>. Do NOT read or search outside this directory.`,
        potentialSavings: 'Saves 30% - 60% of exploratory tokens',
      })
    } else if (pa.hasPath && pa.hasConstraint) {
      items.push({
        id: 'well-scoped-prompt',
        severity: 'good',
        title: 'Well-scoped prompt boundaries',
        summary: 'Prompt targets specific files and declares clear operational constraints.',
      })
    }

    if (pa.isVague) {
      score -= 15
      items.push({
        id: 'vague-prompt',
        severity: 'tip',
        title: 'Prompt phrasing is open-ended',
        summary: 'Vague instructions increase back-and-forth turns and conversational token generation.',
        snippet: `Identify the root cause in <file>, apply the minimal diff, and verify by running <specific_test>.`,
      })
    }
  }

  // 2. Cache efficiency analysis
  if (a.inTok >= 200_000) {
    if (cacheRate < 0.5) {
      score -= 20
      items.push({
        id: 'low-cache-rate',
        severity: 'warning',
        title: `Low prompt cache rate (${Math.round(cacheRate * 100)}%)`,
        summary: 'Only a fraction of input tokens hit the cache. You are paying full price (~10x) on input tokens.',
        detail: `Cached: ${fmt(a.cacheTok)} / Total: ${fmt(a.inTok)}.`,
        snippet: 'Maintain consistent tool call prefixes and avoid reordering context between turns.',
        potentialSavings: `Could save ~$${(cost.withoutCache * 0.7).toFixed(2)} with warm cache`,
      })
    } else if (cacheRate >= 0.85) {
      items.push({
        id: 'high-cache-rate',
        severity: 'good',
        title: `Excellent cache hit rate (${Math.round(cacheRate * 100)}%)`,
        summary: `Saved ~$${cost.saved.toFixed(2)} via Anthropic prompt caching discounts.`,
      })
    }
  }

  // 3. Conversation context bloat (too many turns in one subagent)
  if (a.steps >= 12 && a.inTok >= 1_500_000) {
    score -= 15
    items.push({
      id: 'context-bloat',
      severity: 'warning',
      title: `Long conversation turn chain (${a.steps} steps)`,
      summary: `Each additional turn re-transmits ${fmt(a.ctxTok ?? 60_000)} tokens of context. Long-running single subagents multiply cost.`,
      snippet: 'Break tasks into single-responsibility subagents: 1 agent to locate, 1 agent to edit & test.',
      potentialSavings: 'Reduces compounding input token amplification',
    })
  }

  // 4. Output verbosity check
  const totalOut = a.outTok + Math.round(a.liveOut || 0)
  if (totalOut > 12_000 && a.tools < 3) {
    score -= 10
    items.push({
      id: 'high-output',
      severity: 'tip',
      title: `High output token volume (${fmt(totalOut)} written)`,
      summary: 'Output tokens cost 5x more than input. The agent is producing lengthy explanations.',
      snippet: `Be concise. Return only the root cause in 2 sentences and the exact diff. Skip pleasantries.`,
      potentialSavings: 'Cuts output token billing by up to 50%',
    })
  }

  // 5. Repeated tool call stuck in a loop
  const loop = detectLoop(a.toolLog)
  if (loop) {
    score -= 20
    items.push({
      id: 'repeated-tool-call',
      severity: 'warning',
      title: `Repeated tool call (${loop.count}x in a row)`,
      summary: `${loop.tool} ran ${loop.count} times back to back with the same input — the agent may be stuck in a loop instead of making progress.`,
      detail: loop.detail ? `Last call: ${loop.tool} ${clip(loop.detail, 120)}` : undefined,
      snippet: 'If a tool keeps failing the same way, stop and change approach instead of retrying unchanged.',
      potentialSavings: 'Avoids paying for tool calls and tokens that make no progress',
    })
  }

  // Normalize score
  score = Math.max(15, Math.min(100, score))
  const rating = score >= 85 ? 'Optimal' : score >= 70 ? 'Good' : score >= 50 ? 'Moderate Waste' : 'High Token Bleed'

  return {
    score,
    rating,
    costEst: Number(cost.actual.toFixed(3)),
    costSaved: Number(cost.saved.toFixed(3)),
    cacheRate: Number(cacheRate.toFixed(2)),
    items,
  }
}

export function sessionAdvisor(g: AgentFlowGraph): SessionAdvisorReport {
  const cost = sessionCost(g)
  let totalIn = 0
  let totalCache = 0
  let totalOut = 0
  const allItems: AdvisorItem[] = []
  let totalScore = 0
  let count = 0

  for (const id of g.order) {
    const a = g.agents[id]
    if (!a || a.isProcess) continue
    totalIn += a.inTok
    totalCache += a.cacheTok
    totalOut += a.outTok + Math.round(a.liveOut || 0)
    const rep = advisorReport(a, g)
    totalScore += rep.score
    count += 1
    for (const it of rep.items) {
      if (it.severity !== 'good' && !allItems.some(x => x.id === it.id)) allItems.push(it)
    }
  }

  const overallScore = count > 0 ? Math.round(totalScore / count) : 100
  const cacheRate = totalIn > 0 ? totalCache / totalIn : 1

  return {
    overallScore,
    totalCost: Number(cost.total.toFixed(2)),
    totalSaved: Number(cost.saved.toFixed(2)),
    totalTokens: totalIn + totalOut,
    cacheRate: Number(cacheRate.toFixed(2)),
    topSuggestions: allItems.slice(0, 4),
  }
}
