import type * as UserTypes from "../types/user.ts";

export function serialize(user: UserTypes.User): string {
  return JSON.stringify({ id: user.id, email: user.email });
}
