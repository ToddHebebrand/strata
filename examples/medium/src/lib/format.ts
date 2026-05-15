export function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString();
}
