# VHS tape — Strata explore-chain demo (key-free).
# Regenerate with:  vhs docs/demo/strata-explore.tape   (from the repo root)
# Requires: pnpm -r build first, so packages/cli/dist/cli.js exists.

Output docs/demo/strata-explore.gif

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

Type "# Strata stores a TypeScript codebase as a queryable node graph — not files."
Enter
Sleep 2s

Type "strata modules examples/medium"
Enter
Sleep 4.5s

Type "# Find a declaration by name…"
Enter
Sleep 1.5s

Type "strata find examples/medium User"
Enter
Sleep 3s

Type "# …inspect the node behind that stable ID…"
Enter
Sleep 1.5s

Type "strata show examples/medium a074a656322cd0c7"
Enter
Sleep 4s

Type "# …and ask the thing files can't answer: every resolved reference."
Enter
Sleep 2s

Type "strata refs examples/medium a074a656322cd0c7"
Enter
Sleep 6.5s

Type "# 16 references across 7 modules — imports, type positions, a re-export."
Enter
Sleep 2s

Type "# One structural tool call renames them all: see strata-agent.tape."
Enter
Sleep 3.5s
