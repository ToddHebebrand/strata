# Strata — Go-to-Outcome Strategy

**Date:** 2026-05-15
**Status:** Approved direction, pending spec review
**Owner:** Todd Hebebrand
**Type:** Business/positioning strategy (not a code spec)

---

## 0. Why this document exists

Strata's Phase 4 produced a clean, well-instrumented head-to-head result on the
T03 rename task:

- ~3.5× fewer tokens — **no distribution overlap** (substrate max 1473 < baseline min 4450)
- ~2.2× faster (25–30s vs 57–59s)
- ~3× fewer tool calls (7–11 vs 25–27)
- ~4.9× cheaper (~$0.038 vs ~$0.184/run)
- Success parity: 3/3 both configs, clean `tsc` + `vitest`

This document decides what to *do* with that, given the stated personal goal:
**a funded AI research lab or an early-retirement-scale financial outcome.**
It is the contract for the next phase of non-code work, the same way
`strata-design.md` is the contract for the build.

## 1. Objective — what "win" means here

The stated dream is reached most reliably by being *inside* an org with
unlimited funding doing exactly this work, with raising on traction as the
higher-variance upside. Both are **credibility-and-relationship transactions
decided by one believer with budget — not bottom-up adoption transactions.**

Therefore the deliverable of this phase is **not revenue and not a business.**
It is an **undeniable, reproducible artifact + the right people having seen it.**
Revenue/monetization is *deliberately deferred* (per the chosen "OSS land-grab,
monetize later" direction). Value capture in this phase = the funded role or
raise it unlocks. This is an eyes-open bet, stated here so it is not
sleepwalked into.

## 2. The asset — honest valuation

**What it is:** a strong *directional signal* + working infrastructure + a
sharp thesis. **What it is not yet:** a proven general result.

Strengths that transact: no-overlap token separation (not "lower mean"),
success parity (not "faster but sloppier"), research-grade instrumentation
(distributions, pre-declared retry rule, real example codebase).

Weaknesses a serious reviewer names in 60 seconds, which gate everything below:
- N=3, **one task, and rename is the single most favorable task** for an AST
  substrate. The design doc lists 10 tasks; 1 is benched.
- Baseline-fairness will be attacked first ("did you cripple Claude Code?
  same model? could the baseline use targeted reads?").
- Says nothing yet about scale, messy real code, or type-level ops.

## 3. Paths considered and rejected

- **Sell/license the idea or IP** — rejected as a primary path. Ideas and solo
  artifacts don't command prices; teams, traction, and momentum do. MIT is
  still correct, but for *distribution/credential*, not licensable value.
  "Sell to a lab" collapses into the targeted-outreach path (§5).
- **Standalone Strata-native IDE/agent** — rejected. Users buy experience, not
  engines; the experience bar is set by incumbents with $100M+ war chests.
  Worst risk-adjusted option for a small team.
- **Hosted backend/API for agent builders** — rejected as primary. A slow
  design-partner enterprise sale, ~dozens of customers max, each a potential
  acquirer who could build it. Not an explosion. Allowed later as open-core.

## 4. What ships

Strata as an **MIT-licensed structural substrate + MCP layer that makes the
coding agent people already use dramatically cheaper** — additive, not a
replacement IDE/agent. This intentionally crosses the research MVP's
"out of scope: compat with existing agents" line; that line was correct for
the research artifact and is the *product wedge* here. Log this divergence in
`decisions.md` if/when code work begins.

Land-grab ≠ no focus. One **undeniable hero integration** for the demo:
**Claude Code** (already in that ecosystem, SDK work is reused, cleanest
before/after). Architecture may be agent-agnostic, but one jaw-dropping path
beats mediocre-everywhere.

The viral/credibility mechanic is **not the repo** — it is a 60-second
before/after on a refactor every dev recognizes, **plus a one-command
"reproduce it yourself" harness** (productized from the existing
`packages/bench`). Reproducibility is what makes a skeptical elite audience
spread it *for* you instead of trusting you.

## 5. Sequencing — DECISION

**Primary: targeted private signal first (5a). Fallback/amplifier: public
land-grab (5b), fully pre-built before any outreach.**

Rationale: the funded-lab outcome is decided by one respected person with
budget reading the write-up and thinking "we should fund this person."
Public adoption helps that but is not the mechanism; a single believer is.
Going fully public first tips the thesis to fast-followers and destroys the
"shown early" exclusivity that makes elite recipients lean in. So:

1. Complete §6 hardening (non-negotiable gate).
2. Hand-pick **3–7 exactly-right recipients** — people whose literal job is to
   find this: lab researchers/leads on inference efficiency, coding agents, or
   agent infra; or investors who have *publicly written about this exact
   problem*. Not "famous people." Precision over reach.
3. Reach out with the **pull-ask** (§7). One-shot per recipient; no
   spray-and-pray (the dev/research world is small and it gets back around).
4. If the private channel produces no serious conversation within **~2–3
   weeks** of the last first-contact, execute the **public land-grab** (repo +
   demo + honest write-up + one-command repro + HN/X/community distribution)
   as designed. It is built and ready *before* step 2, not after — it is the
   safety net, not an afterthought.

5b stays specified so the fallback is real: hardened repo (MIT) → 60s demo →
honest write-up *with explicit limitations section* → one-command repro →
distribution. Narrative: *"The file abstraction is the agent bottleneck.
Here are the receipts. Reproduce it yourself in one command."*

## 6. Pre-everything gating work (non-negotiable)

A claim of "5× cheaper" that gets reproduced at 1.3× implodes — privately
(one-shot, no recovery) *and* publicly. Before any outreach or launch:

- **Adversarial tasks at N=5**: extract-function, a cross-module change, a
  bug-fix — deliberately the tasks where structure does *not* trivially win.
  One hostile task that still wins > ten favorable renames.
- **Bulletproofed, documented baseline fairness** — pre-empt "you crippled
  Claude Code" in writing; ideally one outside person tries to break it.
- **Honest write-up** with an explicit limitations section (N, task scope,
  what it does not prove). Candor is a credibility *multiplier* with this
  audience.

This is the gate, not polish-after. Higher stakes than the public path
because targeted outreach is one-shot.

## 7. The outreach posture (so the one shot lands)

- **Pull, not push.** Lead with the artifact + one-command repro + thesis.
  Close with *"I'm trying to decide if this is worth going all-in on — is
  this interesting to you, and who should see it?"* Make the recipient arrive
  at "we should fund this." People who get the bags rarely asked for the bags.
- **Recipient precision is the dominant variable**, not whether a DM was sent.
  Outcome ≈ artifact strength × recipient precision.
- **One first impression per person.** No mass send. Sequence recipients
  worst-fit-first only if you want live-fire practice; otherwise best-fit when
  the artifact is strongest.

## 8. How it ladders to the dream

Believer converts → either a funded role/lab effort (the realistic dream
route, *their* compute and budget) or a raise on real traction (the
higher-variance unlimited upside). Floor if it underperforms: still a
best-in-class research credential and the public land-grab still available.
No doors closed by this sequencing.

## 9. Moat & deferred monetization

MIT does **not** leak the moat. The moat is first-mover brand + speed + a
future hosted team/multi-repo/persistence layer — none given away by the OSS
core. Monetization deferred, but architecture must not preclude that hosted
layer. Named risk: a beloved free tool, platform-fast-followed, zero capture.
Accepted because the curve/credential is the chosen capture vehicle (§1) and
because "the platform copied us and we're the best implementation" is itself
the bull case for the funded-role outcome.

## 10. Kill / pivot criterion

If the §6 adversarial tasks **do not hold up**, do **not** run the viral claim
— privately or publicly. Pivot the same artifact to a quiet research-credential
write-up that is honest about the negative/narrow result (still valuable: "we
tested the substrate thesis and here is where it does and doesn't pay off").
Deciding this now, in writing, is what prevents a weak result from becoming a
one-shot faceplant with exactly the people who matter most.

## 11. Out of scope for this phase

No monetization build, no hosted layer, no standalone IDE, no multi-language,
no fundraising deck before §6 is done. If any of these start feeling urgent,
that is a signal to re-read §1, not to expand scope.

---

*This is a working strategy document. Update it as reality diverges, the same
discipline as `decisions.md` for the build.*
