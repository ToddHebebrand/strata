import { appendFileSync, writeFileSync } from "node:fs";

export interface SessionStartEvent {
  type: "session_start";
  ts: number;
  model: string;
  maxTurns: number;
  task: "T03";
  actor: string;
}

export interface InitEvent {
  type: "init";
  ts: number;
  tools: string[];
  mcpServers: { name: string; status: string }[];
}

export interface ToolCallEvent {
  type: "tool_call";
  ts: number;
  tool: string;
  args: unknown;
  result_summary: string;
  ok: boolean;
  error: string | null;
  durationMs: number;
  turn: number;
}

export interface AssistantTextEvent {
  type: "assistant_text";
  ts: number;
  turn: number;
  text: string;
}

export interface ResultEvent {
  type: "result";
  ts: number;
  subtype: string;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  totalCostUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
  modelUsage: Record<string, unknown>;
  errors: string[];
}

export type SessionLogEvent =
  | SessionStartEvent
  | InitEvent
  | ToolCallEvent
  | AssistantTextEvent
  | ResultEvent;

const MAX_SUMMARY = 240;

export class SessionLog {
  readonly events: SessionLogEvent[] = [];

  constructor(private readonly filePath?: string) {
    if (filePath) {
      writeFileSync(filePath, "");
    }
  }

  append(event: SessionLogEvent): void {
    this.events.push(event);
    if (this.filePath) {
      appendFileSync(this.filePath, `${JSON.stringify(event)}\n`);
    }
  }

  /** Bounded stringification of a tool handler return, never the full text. */
  summarizeResult(value: unknown): string {
    let serialized: string;
    try {
      serialized = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      serialized = String(value);
    }
    if (serialized.length <= MAX_SUMMARY) {
      return serialized;
    }
    return `${serialized.slice(0, MAX_SUMMARY)}...`;
  }

  toJsonl(): string {
    return `${this.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  }

  /** Rewrite the whole file from memory. */
  flush(): void {
    if (this.filePath) {
      writeFileSync(this.filePath, this.toJsonl());
    }
  }
}
