# @strata-code/cli

The Strata command line: explore and mutate a TypeScript codebase as a structural node graph, and run the no-filesystem agent.

Strata is an agent-native structural code substrate — a queryable, transactional code graph that replaces files as an AI agent's interface to a codebase. Files exist only as transient artifacts for the type-checker; the graph is canonical.

```bash
npm i -g @strata-code/cli

strata modules ./my-ts-project          # list module nodes
strata find ./my-ts-project User        # find declarations by name
strata show ./my-ts-project <nodeId>    # inspect one node
strata refs ./my-ts-project <nodeId>    # every resolved reference — the thing files can't answer
strata search ./my-ts-project "date range"

# with ANTHROPIC_API_KEY set — run the structural agent (no filesystem tools):
strata agent ./my-ts-project "Rename the exported interface User to Account everywhere it is referenced" --print
```

All explore commands are key-free and read-only, work on any TypeScript directory (ephemeral ingest) or a persisted `.db`, and take `--json`.

Full architecture, measured results (when a structural substrate beats file tools ~3–5× and when it doesn't), and the multi-agent coordination kernel: [github.com/ToddHebebrand/strata](https://github.com/ToddHebebrand/strata).

MIT.
