import type { User } from "./types/user";

/**
 * @param {User} u
 */
export function greet(u: User): string {
  return u.id;
}

export type Users = User[];
