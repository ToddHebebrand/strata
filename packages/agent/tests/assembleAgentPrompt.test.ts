import { describe, expect, it } from "vitest";
import { assembleAgentPrompt } from "../src/runAgent";

describe("assembleAgentPrompt pins L1/L3 ordering and separator", () => {
  const userPrompt = "Rename User to Account everywhere";
  const codebaseShapeSection =
    "## Codebase shape\n\n- src/user.ts\n  - User (interface, exported)";
  const pastTasksSection =
    "## Past tasks like this one\n\n" +
    "- Rename User to Account\n" +
    "  ops: RenameSymbol\n" +
    "  modules: src/user.ts\n" +
    "  declarations: User";

  it("case 1: module index only (L1 on, L3 cold) — shape \\n\\n --- \\n\\n prompt", () => {
    const assembled = assembleAgentPrompt({
      codebaseShapeSection,
      pastTasksSection: null,
      userPrompt
    });
    expect(assembled).toBe(
      "## Codebase shape\n\n- src/user.ts\n  - User (interface, exported)\n\n---\n\nRename User to Account everywhere"
    );
  });

  it("case 2: module index + past tasks (L1 on, L3 populated) — byte-exact", () => {
    const assembled = assembleAgentPrompt({
      codebaseShapeSection,
      pastTasksSection,
      userPrompt
    });
    expect(assembled).toBe(
      "## Codebase shape\n\n- src/user.ts\n  - User (interface, exported)\n\n" +
        "## Past tasks like this one\n\n" +
        "- Rename User to Account\n" +
        "  ops: RenameSymbol\n" +
        "  modules: src/user.ts\n" +
        "  declarations: User\n\n" +
        "---\n\n" +
        "Rename User to Account everywhere"
    );
  });

  it("case 3: no index, no past tasks — user prompt passes through unchanged", () => {
    const assembled = assembleAgentPrompt({
      codebaseShapeSection: null,
      pastTasksSection: null,
      userPrompt
    });
    expect(assembled).toBe(userPrompt);
  });

  it("case 4: no index + populated L3 — past tasks still inject (L3 is independent of L1)", () => {
    const assembled = assembleAgentPrompt({
      codebaseShapeSection: null,
      pastTasksSection,
      userPrompt
    });
    expect(assembled).toBe(
      "## Past tasks like this one\n\n" +
        "- Rename User to Account\n" +
        "  ops: RenameSymbol\n" +
        "  modules: src/user.ts\n" +
        "  declarations: User\n\n" +
        "---\n\n" +
        "Rename User to Account everywhere"
    );
  });
});
