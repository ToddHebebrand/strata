import type { User } from "../types/user.ts";

export async function listUsers(load: () => Promise<User[]>): Promise<User[]> {
  return load();
}
