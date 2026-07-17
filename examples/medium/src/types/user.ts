/**
 * Represents a user of the system.
 * @internal
 */
export interface User {
  id: string;
  email: string;
}

export function displayUser(user: User): string {
  return user.email;
}
