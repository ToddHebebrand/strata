import { formatTimestamp } from "../lib/format.ts";

export function timelineRows(times: number[]): string[] {
  return times.map((t) => formatTimestamp(t));
}

export function firstRow(times: number[]): string {
  return timelineRows(times)[0] ?? formatTimestamp(0);
}
