import { describe, expect, it } from "vitest";
import {
  countBaselineRetries,
  countSubstrateRetries,
  type BaselineToolEvent,
  type SubstrateToolEvent
} from "../src/retry";

describe("countSubstrateRetries", () => {
  it("counts a failed validate followed by a further mutation as ONE retry", () => {
    const events: SubstrateToolEvent[] = [
      { tool: "find_declarations", ok: true },
      { tool: "begin_transaction", ok: true },
      { tool: "rename_symbol", ok: true },
      { tool: "validate", ok: true, returnedDiagnostics: true },
      { tool: "rollback_transaction", ok: true },
      { tool: "begin_transaction", ok: true },
      { tool: "rename_symbol", ok: true },
      { tool: "validate", ok: true, returnedDiagnostics: false },
      { tool: "commit_transaction", ok: true, commitOk: true }
    ];
    expect(countSubstrateRetries(events)).toBe(1);
  });

  it("counts a commit_transaction ok:false followed by another rename as a retry", () => {
    const events: SubstrateToolEvent[] = [
      { tool: "begin_transaction", ok: true },
      { tool: "rename_symbol", ok: true },
      { tool: "commit_transaction", ok: true, commitOk: false },
      { tool: "begin_transaction", ok: true },
      { tool: "rename_symbol", ok: true },
      { tool: "commit_transaction", ok: true, commitOk: true }
    ];
    expect(countSubstrateRetries(events)).toBe(1);
  });

  it("does NOT count a failed check with no subsequent mutation", () => {
    const events: SubstrateToolEvent[] = [
      { tool: "begin_transaction", ok: true },
      { tool: "rename_symbol", ok: true },
      { tool: "validate", ok: true, returnedDiagnostics: true }
    ];
    expect(countSubstrateRetries(events)).toBe(0);
  });
});

describe("countBaselineRetries", () => {
  it("counts a non-zero tsc/test Bash run followed by a further edit as one retry", () => {
    const events: BaselineToolEvent[] = [
      { tool: "Read", path: "src/types/user.ts" },
      { tool: "Edit", path: "src/types/user.ts" },
      { tool: "Bash", command: "pnpm tsc --noEmit", exitCode: 2 },
      { tool: "Edit", path: "src/users/list.ts" },
      { tool: "Bash", command: "pnpm vitest run", exitCode: 0 }
    ];
    expect(countBaselineRetries(events)).toBe(1);
  });

  it("counts a re-edit of an already-edited file followed by another edit as a retry", () => {
    const events: BaselineToolEvent[] = [
      { tool: "Edit", path: "src/types/user.ts" },
      { tool: "Edit", path: "src/users/greet.ts" },
      { tool: "Edit", path: "src/types/user.ts" },
      { tool: "Write", path: "src/index.ts" }
    ];
    expect(countBaselineRetries(events)).toBe(1);
  });

  it("does NOT count a failed tsc with no subsequent edit", () => {
    const events: BaselineToolEvent[] = [
      { tool: "Edit", path: "src/types/user.ts" },
      { tool: "Bash", command: "pnpm tsc --noEmit", exitCode: 1 }
    ];
    expect(countBaselineRetries(events)).toBe(0);
  });
});
