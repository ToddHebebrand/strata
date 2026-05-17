export function isWithinRange(date: Date, start: Date, end: Date): boolean {
  return date >= start && date <= end;
}
