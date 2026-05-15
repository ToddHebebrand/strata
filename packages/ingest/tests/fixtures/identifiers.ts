export interface User {
  id: string;
}

export function greet(user: User): string {
  return `hello ${user.id}`;
}
