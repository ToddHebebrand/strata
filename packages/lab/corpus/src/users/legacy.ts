import type { User } from "../types/user.ts";

/**
 * @param {User} u
 * @returns {string}
 */
export function legacyId(u: User): string {
  return u.id;
}
