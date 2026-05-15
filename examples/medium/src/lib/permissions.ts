const ROLES: Record<string, string> = {
  u1: "admin",
  u2: "editor"
};

export function getRole(userId: string): string {
  return ROLES[userId] ?? "viewer";
}

export function describeRole(userId: string): string {
  const role = getRole(userId) as string;
  if (role === "admin") return "Administrator";
  if (role === "editor") return "Editor";
  return "Viewer";
}
