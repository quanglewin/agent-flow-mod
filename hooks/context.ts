import { clip, est, summarizeTool } from './model'

/**
 * What an agent's context window holds, read from its transcript: the task it was given, what it
 * wrote, the tools it called and what came back. The browser page shows this per agent.
 */

export type CtxKind = 'prompt' | 'user' | 'reply' | 'call' | 'result' | 'error'

export type CtxEntry = {
  kind: CtxKind
  /** One line: the tool call, the tool whose result this is, or "Task" / "You". */
  title: string
  /** Estimated tokens it takes in the context (characters / 4). */
  tok: number
  /** The opening of its text, to read without the whole transcript. */
  preview: string
}

export type CtxSnapshot = {
  at: number
  /** Messages in the conversation. */
  msgs: number
  /** Estimated tokens by kind, over every message (not only the entries kept). */
  parts: Record<CtxKind, number>
  /** The newest entries, oldest first; the first prompt is always kept. */
  entries: CtxEntry[]
  /** Entries left out between the first prompt and the kept ones. */
  skipped: number
  /** Why the transcript could not be read, when it could not. */
  denied?: string
}

/** The rows `$.session.messages` gives, as far as this summary reads them. */
export type MessageRow = {
  role: 'user' | 'assistant'
  text: string
  toolUses?: readonly { tool_use_id: string; tool: string; input: Record<string, unknown> }[]
  toolResults?: readonly { tool_use_id: string; text: string; isError: boolean }[]
}

export const ENTRY_MAX = 120
const PREVIEW = 420
const PROMPT_PREVIEW = 6000

function emptyParts(): Record<CtxKind, number> {
  return { prompt: 0, user: 0, reply: 0, call: 0, result: 0, error: 0 }
}

function body(text: string, max: number): string {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/**
 * Summarizes a transcript. For a subagent the first user message is the task it was handed; for
 * the main loop user messages are yours.
 */
export function summarize(rows: readonly MessageRow[], isMain: boolean, now: number): CtxSnapshot {
  const parts = emptyParts()
  const entries: CtxEntry[] = []
  const toolNames = new Map<string, { tool: string; input: Record<string, unknown> }>()
  let firstUser = true
  for (const row of rows) {
    if (row.role === 'assistant') {
      if (row.text.trim()) {
        const tok = est(row.text.length)
        parts.reply += tok
        entries.push({ kind: 'reply', title: 'Wrote', tok, preview: body(row.text, PREVIEW) })
      }
      for (const use of row.toolUses ?? []) {
        toolNames.set(use.tool_use_id, { tool: use.tool, input: use.input })
        let json = ''
        try {
          json = JSON.stringify(use.input) ?? ''
        } catch {
          json = ''
        }
        const tok = est(json.length + use.tool.length)
        parts.call += tok
        entries.push({ kind: 'call', title: clip(summarizeTool(use.tool, use.input ?? {}), 120), tok, preview: body(json, PREVIEW) })
      }
      continue
    }
    const results = row.toolResults ?? []
    for (const r of results) {
      const tok = est(r.text.length)
      const named = toolNames.get(r.tool_use_id)
      const kind: CtxKind = r.isError ? 'error' : 'result'
      parts[kind] += tok
      entries.push({
        kind,
        title: named ? `${r.isError ? 'Error from' : 'Result of'} ${clip(summarizeTool(named.tool, named.input ?? {}), 100)}` : 'Tool result',
        tok,
        preview: body(r.text, PREVIEW),
      })
    }
    if (row.text.trim()) {
      const tok = est(row.text.length)
      const kind: CtxKind = !isMain && firstUser ? 'prompt' : 'user'
      parts[kind] += tok
      entries.push({
        kind,
        title: kind === 'prompt' ? 'The task it was handed' : isMain ? 'You' : 'Message to it',
        tok,
        preview: body(row.text, kind === 'prompt' ? PROMPT_PREVIEW : PREVIEW),
      })
    }
    if (results.length === 0 || row.text.trim()) firstUser = false
  }
  let kept = entries
  let skipped = 0
  if (entries.length > ENTRY_MAX) {
    const head = entries[0]?.kind === 'prompt' ? entries.slice(0, 1) : []
    const tail = entries.slice(entries.length - (ENTRY_MAX - head.length))
    skipped = entries.length - head.length - tail.length
    kept = [...head, ...tail]
  }
  return { at: now, msgs: rows.length, parts, entries: kept, skipped }
}
