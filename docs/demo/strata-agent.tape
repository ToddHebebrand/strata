# VHS tape — Strata agent rename demo (KEYED — live model spend, ~$0.05).
# Regenerate with:  vhs docs/demo/strata-agent.tape   (from the repo root,
# with ANTHROPIC_API_KEY set or a logged-in Claude Code install).
#
# The demo corpus is a copy of examples/medium minus tests/format.test.ts:
# that file is the T01 acceptance test and fails type-check against the
# pristine corpus BY DESIGN (it asserts a parameter the T01 task is
# supposed to add), so the commit gate would correctly refuse any commit
# on the unmodified corpus. The copy keeps tests/dateRange.test.ts, so the
# gate still runs a real test suite before finalizing.
#
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
Type "export PATH=/opt/homebrew/bin:$PATH; alias strata='node packages/cli/dist/cli.js'; rm -rf /tmp/strata-demo && cp -R examples/medium /tmp/strata-demo && rm /tmp/strata-demo/tests/format.test.ts; clear"
Enter
Show

Type "# Now let an agent — with NO filesystem tools — do the rename structurally."
Enter
Sleep 2s

Type `strata agent /tmp/strata-demo "Rename the exported interface User to Account everywhere it is referenced" --print`
Enter
# Live run: T03-class renames complete in ~20-45s; leave headroom.
Sleep 75s

Type "# One structural rename — validated by tsc + the project's tests before commit."
Enter
Sleep 3.5s
