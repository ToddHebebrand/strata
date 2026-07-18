# VHS tape — Strata agent rename demo (KEYED — live model spend, ~$0.05).
# Operator-run only:  ANTHROPIC_API_KEY must be set in the environment first.
# Regenerate with:    vhs docs/demo/strata-agent.tape   (from the repo root)
# The agent has no filesystem tools; the rename lands through the reference
# graph and the validating commit gate (tsc + corpus tests) in one transaction.

Output docs/demo/strata-agent.gif

Set FontSize 15
Set Width 1280
Set Height 720
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Hide
Type "export PATH=/opt/homebrew/bin:$PATH; alias strata='node packages/cli/dist/cli.js'; clear"
Enter
Show

Type "# Now let an agent — with NO filesystem tools — do the rename structurally."
Enter
Sleep 2s

Type `strata agent examples/medium "Rename the exported interface User to Account everywhere it is referenced" --print`
Enter
# Live run: T03-class renames complete in ~25-35s; leave headroom.
Sleep 75s

Type "# One structural rename, validated by tsc + tests before commit. Done."
Enter
Sleep 3.5s
