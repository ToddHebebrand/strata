export const AGENT_PACKAGE = "@strata-code/agent" as const;
export {
  SessionLog,
  type CommitPatternEmbedEvent,
  type EmbeddingsBuiltEvent,
  type EmbeddingsFailedEvent,
  type InitEvent,
  type ModuleIndexInjectedEvent,
  type PastTasksFailedEvent,
  type PastTasksInjectedEvent,
  type ResultEvent,
  type SessionLogEvent,
  type ToolCallEvent
} from "./log";
export { buildModuleIndex } from "./moduleIndex";
export { STRATA_SYSTEM_PROMPT } from "./prompt";
export {
  runHermeticSession,
  type HermeticQuery,
  type HermeticSessionCallbacks,
  type HermeticSessionResult,
  type HermeticTerminalReason,
  type HermeticToolResultEvent,
  type HermeticToolUseEvent,
  type RunHermeticSessionParams
} from "./hermeticSession";
export {
  classifySessionError,
  collectSession,
  loadTranscriptFixture,
  normalizeTranscriptForFixture,
  runAgentLab,
  runAgentT03,
  runAgentTask,
  singlePrompt,
  T01_PROMPT,
  T03_PROMPT,
  T05_PROMPT,
  T08_PROMPT,
  TASK_PROMPTS,
  type AgentLabResult,
  type AgentT03Result,
  type AgentTaskResult,
  type BenchTaskId,
  type LabCriteria,
  type ReplayStep,
  type RunAgentLabParams,
  type RunAgentT03Params,
  type RunAgentTaskParams,
  type TaskCriteria,
  type TerminalReason
} from "./session";
export {
  assembleAgentPrompt,
  fixturesForBenchTask,
  runAgent,
  type AgentResult,
  type AssembleAgentPromptInput,
  type RunAgentParams
} from "./runAgent";
export {
  BASELINE_TOOLS,
  collectBaselineSession,
  countBaselineRetries,
  materializeCorpus,
  type BaselineResultCapture,
  type BaselineSession,
  type BaselineToolEvent,
  type MaterializeCorpusOptions
} from "./baselineShared";
export {
  runBaseline,
  type BaselineResult,
  type RunBaselineParams
} from "./runBaseline";
export {
  createStrataTools,
  createStrataToolServer,
  STRATA_QUALIFIED_TOOL_NAMES,
  STRATA_SERVER_NAME,
  STRATA_TOOL_NAMES,
  type StrataSessionContext
} from "./tools";
