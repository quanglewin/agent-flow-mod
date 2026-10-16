import { describe, expect, test } from 'claude-code/testing'

import * as M from '../hooks/model'
import { RASTER_TRAVEL_MS, renderRaster } from '../hooks/raster'

describe('raster', () => {
  test('a packet in flight moves from frame to frame; a still map does not', async () => {
    const g = M.emptyGraph(0)
    M.spawn(g, { id: 'a1', type: 'Explore', description: 'Map the auth flow', prompt: 'x'.repeat(200) }, 10_000)
    M.turnComplete(g, 'a1', { answer: 'done', reason: 'answer' }, 10_000)
    for (const l of g.links) l.at = 0

    const still = renderRaster(g, 60_000, 90, 30)
    expect(renderRaster(g, 60_500, 90, 30).cells).toBe(still.cells)
    expect(still.text.join('\n')).toContain('Explore #1')
    expect(still.text.join('\n')).toContain('MAIN')

    M.addLink(g, M.MAIN, 'a1', 'spawn', 'more work', 70_000, 820)
    const early = renderRaster(g, 70_000 + RASTER_TRAVEL_MS * 0.2, 90, 30)
    const later = renderRaster(g, 70_000 + RASTER_TRAVEL_MS * 0.7, 90, 30)
    expect(later.cells).not.toBe(early.cells)
    expect(early.text.join('\n')).toContain('↓820')
    const landed = renderRaster(g, 70_000 + RASTER_TRAVEL_MS + 100, 90, 30)
    expect(landed.text.join('\n')).toContain('+820 tok')
  })

  test('cells are columns × rows triplets and fit the limits', async () => {
    const g = M.emptyGraph(0)
    const f = renderRaster(g, 0, 900, 900)
    expect(f.columns).toBe(512)
    expect(f.rows).toBe(256)
    expect(atob(f.cells).length).toBe(512 * 256 * 12)
  })
})
