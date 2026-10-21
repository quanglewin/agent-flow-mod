# AGENT//FLOW

See what your Claude Code agents are doing, live.

When Claude starts subagents, it is hard to tell who is doing what, how far along they are, and when the work will be done. AGENT//FLOW draws it for you: every agent, the tasks passed between them, and how many tokens they use.

![AGENT//FLOW in action: running agents, dragging an orb, reading an agent's context and a task, the timeline, and the run finishing](docs/demo.gif)

[Watch it in full quality (MP4)](docs/demo.mp4)

## What you get

- **A live map.** Each agent is a glowing circle. Running agents have spinning rings; finished ones go quiet. An icon in the middle shows the kind of work (search, plan, code, review, test…). Drag the circles to arrange them.
- **"Is it done yet?"** A status box shows RUNNING or DONE, how many planned steps are finished, and a time estimate based on earlier runs. Turn on the bell to get a sound and a notification when it finishes.
- **Every message.** Click any task or report to read it in full: the exact prompt an agent was given and the answer it sent back.
- **What each agent sees.** The Context tab lists what is in an agent's context window: its task, its tool calls, and the results.
- **Prompt & Token Efficiency Advisor.** Real-time efficiency score (0–100), estimated USD cost, and prompt cache savings. Detects token waste patterns (unconstrained search, low cache hits, conversational bloat, an agent stuck repeating the same tool call), suggests 1-click prompt improvements, and generates custom `CLAUDE.md` rules to prevent token bleed.
- **A timeline.** When each agent started and finished, how fast it wrote, and every tool call.
- **A replay.** Scrub through a finished (or still running) session from snapshots taken every couple of seconds, with play/pause and speed controls.
- **Run history and compare.** Every session is remembered (cost, tokens, score, most-used tools and agent types), across restarts. Pick any two runs to see what changed.
- **A budget alert.** Set a USD threshold and get a sound and notification once a session's estimated cost passes it.
- **Export.** One click (or `/agent-flow export`) turns a session into a Markdown or JSON report you can keep or share.
- **Open in your editor.** Click a Read/Write/Edit call in an agent's tool log to open that file in VS Code or Cursor.
- **One tab per session.** Running Claude Code in several windows? Each one gets its own tab.

Finished agents leave the map after a minute so you can focus on what is running. Click "Show" to bring them back.

## Install

You need Claude Code with mod support. Works on macOS, Windows, Linux and WSL.

```sh
claude plugin marketplace add quanglewin/agent-flow-mod
claude plugin install agent-flow@claude-mods
```

Then, in each open Claude Code window, run:

```
/reload-plugins
```

## Use

In Claude Code:

| Command | What it does |
|---|---|
| `/agent-flow web` | Open the dashboard in your browser |
| `/agent-flow web demo` | Play a demo, no real agents needed |
| `/agent-flow web off` | Stop sending this session to the dashboard |
| `/agent-flow advisor` | Terminal summary of session token efficiency, cost, and prompt tips |
| `/agent-flow budget <amount>` | Flag this session once its cost passes `<amount>` USD (`budget off` clears it) |
| `/agent-flow export` or `export json` | Write this session's report to a Markdown or JSON file |
| `/agent-flow history` | List recent runs, with the most-used tool and agent type |
| `/agent-flow compare [a] [b]` | Diff two runs' cost, tokens, score and cache rate (defaults to the two most recent) |
| `/agent-flow` | Show the map inside Claude Code (terminal or desktop app) |
| `/agent-flow compact` or `detail` | Circles or cards inside Claude Code |
| `/agent-flow reset` | Clear the map |

Tip: in the Ghostty or kitty terminal, the map inside Claude Code is drawn with real pixels.

## Update

```sh
claude plugin marketplace update claude-mods
```

Then run `/reload-plugins` in Claude Code.

## Uninstall

```sh
claude plugin uninstall agent-flow@claude-mods
```

## Where the files go

The dashboard is a plain HTML file on your computer. There is no server, and nothing is sent anywhere.

- macOS, Windows, WSL: `~/.claude/agent-flow/`
- Linux desktop: `~/agent-flow/` (Snap browsers cannot open hidden folders)
- Or set `AGENT_FLOW_DIR` to any folder you like.

## Privacy

The mod reads what Claude Code shares with mods: agents starting and stopping, token counts, tool calls, messages between agents, and each agent's conversation (for the Context tab). It writes this only to the folder above. A mod runs inside Claude Code with the same access as Claude Code, so read the code before you install any mod, including this one.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Unknown command: /agent-flow` | Run `/reload-plugins`, or restart Claude Code. |
| The dashboard says "Waiting" or shows no tabs | Run `/agent-flow web` in the session you want to watch. |
| A tab says "No data" | That session is closed or still runs an old version. Run `/reload-plugins` in it. |
| An agent is called "agent #2" | It started before the mod was loaded. New agents get real names. |

## Develop

```sh
claude plugin validate .
claude plugin test .
```

Change the files, then run `/reload-plugins` in Claude Code.

- `hooks/register.tsx`: entry point, listens to Claude Code events
- `hooks/model.ts`: the agent graph
- `hooks/context.ts`: reads each agent's context
- `hooks/advisor.ts`: prompt & token efficiency engine
- `web/index.html`: the browser dashboard

## License

MIT
