import { formatTimestamp } from "../lib/format.ts";

export function logEvent(at: number, kind: string): string {
  return `${kind} @ ${formatTimestamp(at)}`;
}

export function eventLine(at: number): string {
  return formatTimestamp(at);
}
