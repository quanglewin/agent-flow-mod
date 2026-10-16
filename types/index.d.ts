export type AgentFlowStatus = 'running' | 'idle' | 'done' | 'error'

export type AgentFlowAgent = {
  id: string
  /** Short display name: MAIN, Explore #1, or the Agent call's name. */
  label: string
  /** The agent type it runs as (general-purpose, Explore, ...). */
  type: string
  /** What it was asked to do: the Agent call's description. */
  role: string
  /** The opening of the prompt it was given. */
  task: string
  parent?: string
  /** Index into the neon palette. */
  color: number
  status: AgentFlowStatus
  model?: string
  /** Context tokens processed (uncached + cache read + cache write), summed over requests. */
  inTok: number
  outTok: number
  cacheTok: number
  steps: number
  tools: number
  /** What it is doing right now (a tool call), if anything. */
  activity?: string
  /** Estimated output tokens of the request streaming now. */
  liveOut: number
  /** Output tokens per second of the latest request. */
  tps: number
  peakTps: number
  stepStartedAt?: number
  firstChunkAt?: number
  /** liveOut once the first chunk was in: the rate counts what came after it. */
  firstOut?: number
  startedAt: number
  endedAt?: number
  /** When it last did anything visible (a token, a tool call starting or ending). */
  lastActiveAt?: number
  /** Its most recent tool calls, oldest first, at most TOOL_LOG_MAX. */
  toolLog?: AgentFlowToolEntry[]
  /** Context it worked over in its latest request: uncached + cache read + cache write. */
  ctxTok?: number
  /** The report it handed back, as far as the map keeps it. */
  result?: string
  /** Its plan, from TodoWrite or TaskCreate/TaskUpdate: what "done" means for it. */
  todos?: AgentFlowTodo[]
  /** True when this node represents an external process (Bash), not a real agent. */
  isProcess?: boolean
}

export type AgentFlowToolEntry = { at: number; end?: number; text: string }

export type AgentFlowTodo = {
  id?: string
  text: string
  /** Present-tense form shown while it is in progress. */
  active?: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Two agents that messaged each other directly (not parent and child): a standing channel on the map. */
export type AgentFlowChannel = { a: string; b: string; count: number; tokens: number; last: number }

/** Which drawing the pane shows: orbs (one circle per agent) or detailed cards. */
export type AgentFlowView = 'compact' | 'detail'

export type AgentFlowLinkKind = 'spawn' | 'report' | 'message'

export type AgentFlowLink = {
  id: number
  from: string
  to: string
  kind: AgentFlowLinkKind
  /** Tokens carried: estimated from the text (chars / 4). */
  tokens: number
  /** The opening of what was carried. */
  text: string
  at: number
}

export type AgentFlowGraph = {
  agents: Record<string, AgentFlowAgent>
  /** Agent ids in the order they appeared. */
  order: string[]
  links: AgentFlowLink[]
  /** Direct message channels, kept even after their links scroll out of `links`. */
  channels?: Record<string, AgentFlowChannel>
  seq: number
  opened: boolean
  startedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-flow': {
      graph: AgentFlowGraph
      tick: number
      view: AgentFlowView
      /** The graph as the desktop's SVG last drew it: refreshed on visible changes only. */
      scene: AgentFlowGraph
    }
  }
}
