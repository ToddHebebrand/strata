import type { User } from "../types/user.ts";

export interface UserRepo {
  byId(id: string): Promise<User | undefined>;
  all(): Promise<User[]>;
  save(user: User): Promise<void>;
}

export function emptyRepo(): UserRepo {
  return {
    byId: async () => undefined,
    all: async () => [],
    save: async () => {}
  };
}
