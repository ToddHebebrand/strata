export type AuditKind = "User" | "Session" | "Token";

export interface AuditEntry {
  kind: AuditKind;
  subjectId: string;
  ts: number;
}

export function userAudit(subjectId: string, ts: number): AuditEntry {
  return { kind: "User", subjectId, ts };
}
