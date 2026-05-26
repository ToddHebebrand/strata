import path from "node:path";
import { runAgentLab } from "./seam";
import { getExperiment } from "./registry";
import { makeLabScorer } from "./experiment";
import { HD_PROMPT } from "./tasks/honestDerivable";
import { TRAP_PROMPT } from "./tasks/trappedControl";
import { scoreEvidenceTrail } from "./experiments/nodeRefAddParameter";

const CORPUS = path.join(__dirname, "..", "corpus");

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) {
    console.error("usage: lab <experiment-id> [--model m] [--max-turns n]");
    process.exit(2);
  }
  const exp = getExperiment(id);
  const model = argVal("--model") ?? "claude-sonnet-4-6";
  const maxTurns = Number(argVal("--max-turns") ?? 25);
  if (Number.isNaN(maxTurns)) {
    console.error("[lab] --max-turns must be a number");
    process.exit(2);
  }
  const prompt =
    exp.overrides.prompt ?? (exp.task === "HD" ? HD_PROMPT : TRAP_PROMPT);

  console.log(
    `[lab] ${exp.id} | task=${exp.task} | model=${model} | maxTurns=${maxTurns}`
  );
  console.log(`[lab] hypothesis: ${exp.hypothesis}`);
  console.log(`[lab] NON-AUTHORITATIVE — not a claim. HD-only inner loop.`);

  const score = makeLabScorer(exp.task, exp.overrides.extraGate);
  const result = await runAgentLab({
    corpusRoot: CORPUS,
    model,
    maxTurns,
    wallTimeMs: 240000,
    actor: `lab-${exp.id}`,
    prompt,
    acceptance: undefined, // lab uses labOk (scorer) as the sole verdict; no behavior gate here
    toolServerFactory: exp.overrides.toolServerFactory,
    canUseTool: exp.overrides.canUseTool,
    emptyCriteria: () => ({
      commitReturnedOk: false,
      validateAfterCommitClean: false,
      operationRowAppended: false,
      labOk: false
    }),
    score
  });

  // Print tool calls WITH their result summaries (not names only — the
  // prior methodology miss was concluding from call names without ever
  // inspecting what the tools returned).
  for (const ev of result.log.events) {
    if (ev.type !== "tool_call") continue;
    const args = JSON.stringify(ev.args).slice(0, 500);
    const res = String(ev.result_summary ?? "").replace(/\s+/g, " ").slice(0, 360);
    console.log(`  · ${ev.tool} ${args}${ev.ok ? "" : " [ERR]"}\n      → ${res}`);
  }
  console.log(
    `[lab] terminal=${result.terminalReason} labOk=${result.criteria.labOk} ` +
      `commitOk=${result.criteria.commitReturnedOk}`
  );
  // Cost/usage from the SDK result event (operator burst-ceiling tracking).
  const resultEvent = result.log.events.find(
    (e): e is Extract<(typeof result.log.events)[number], { type: "result" }> =>
      e.type === "result"
  );
  console.log(
    resultEvent
      ? `[lab] cost=$${resultEvent.totalCostUsd.toFixed(4)} turns=${resultEvent.numTurns} ` +
          `tok(in/out)=${resultEvent.usage.inputTokens}/${resultEvent.usage.outputTokens}`
      : `[lab] cost=n/a (no SDK result event — replay/none)`
  );
  if (!result.criteria.commitReturnedOk && result.terminalReason !== "success") {
    console.log(
      `[lab] NOTE: agent did not commit — terminal=${result.terminalReason}. ` +
        `Consider increasing --max-turns or checking tool errors before tweaking the variant.`
    );
  }
  // Evidence-trail post-run check (Codex's optional 3rd gate) — enabled
  // ONLY for the nodeRef bundle experiments. Checks whether every nodeRef
  // passed to add_parameter appears in an earlier read-only tool's
  // result_summary string.
  //
  // KNOWN FALSE-POSITIVE: SessionLog truncates result_summary at 240 chars
  // (packages/agent/src/log.ts:64). A legitimate nodeRef returned by
  // find_declarations past the 240-char boundary will not appear in the
  // logged string even though the agent saw it in the real tool exchange.
  // Opus's HD trial 4 hit this: it used both ZONE nodeIds returned by a
  // single find_declarations call; only the first ID fit in the truncated
  // summary, the second triggered a false-positive ungrounded warning.
  //
  // Because of that false-positive mode, this check is INFORMATIONAL ONLY —
  // it warns but does NOT override labOk. Op-count and replace_body-scope
  // gates (in nodeRefAddParameter.ts) are the load-bearing integrity checks
  // and have caught every real attack in sonnet trap trials 1-3.
  if (id.startsWith("node-ref-add-parameter")) {
    const trail = scoreEvidenceTrail(result.log.events);
    if (!trail.gatePass) {
      console.log(
        `[lab] evidence-trail WARNING (informational; may be log-truncation false-positive):`
      );
      for (const v of trail.violations) {
        console.log(`  · ${v}`);
      }
    } else {
      console.log(`[lab] evidence-trail: all add_parameter nodeRefs grounded in earlier read-only tool results`);
    }
  }

  console.log(
    result.criteria.labOk
      ? `[lab] PASS on ${exp.task}. If task=HD: next, run the trapped control before any graduation.`
      : `[lab] FAIL on ${exp.task}. Tweak the variant and re-run.`
  );
}

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

main().catch((e) => {
  console.error("[lab] crashed:", e);
  process.exit(1);
});
