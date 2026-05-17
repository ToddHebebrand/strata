import type { User } from "../types/user.ts";

/**
 * Greet a user by name.
 * @param {User} user
 */
export function greet(user: User): string {
  return `hello ${user.email}`;
}
