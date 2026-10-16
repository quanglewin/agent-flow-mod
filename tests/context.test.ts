import { describe, expect, test } from 'claude-code/testing'

import { ENTRY_MAX, summarize } from '../hooks/context'

describe('context', () => {
  test("a subagent's transcript reads as its task, its tool calls and what came back", async () => {
    const snap = summarize(
      [
        { role: 'user', text: 'Map the auth flow' },
        { role: 'assistant', text: 'Looking.', toolUses: [{ tool_use_id: 'x', tool: 'Grep', input: { pattern: 'jwt' } }] },
        { role: 'user', text: '', toolResults: [{ tool_use_id: 'x', text: 'no matches', isError: true }] },
      ],
      false,
      5,
    )
    expect(snap.entries.map(e => [e.kind, e.title])).toEqual([
      ['prompt', 'The task it was handed'],
      ['reply', 'Wrote'],
      ['call', 'Grep jwt'],
      ['error', 'Error from Grep jwt'],
    ])
    expect(snap.parts.prompt).toBe(5)
    expect(snap.msgs).toBe(3)
  })

  test("main's user messages are yours, and a long transcript keeps the task and the newest entries", async () => {
    const rows = [{ role: 'user' as const, text: 'Hi' }]
    for (let k = 0; k < 200; k += 1) rows.push({ role: 'user' as const, text: `m${k}` })
    expect(summarize(rows, true, 0).entries[0]?.title).toBe('You')
    const sub = summarize(rows, false, 0)
    expect(sub.entries).toHaveLength(ENTRY_MAX)
    expect(sub.entries[0]?.kind).toBe('prompt')
    expect(sub.entries.at(-1)?.preview).toBe('m199')
    expect(sub.skipped).toBe(201 - ENTRY_MAX)
  })
})
