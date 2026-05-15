// Exercises: discriminated unions, exhaustive switch with `never`,
// type predicates, tagged unions, narrowing on `in`, and Result helpers.

/** Tagged result type: success carries data, failure carries an error. */
export type Result<T, E = Error> =
  | { kind: "ok"; value: T }
  | { kind: "err"; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { kind: "ok", value };
}

export function err<E>(error: E): Result<never, E> {
  return { kind: "err", error };
}

export function isOk<T, E>(
  result: Result<T, E>,
): result is { kind: "ok"; value: T } {
  return result.kind === "ok";
}

/** A small DSL: each shape carries enough information to compute area. */
export type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; side: number }
  | { kind: "rectangle"; width: number; height: number }
  | { kind: "triangle"; base: number; height: number };

export function area(shape: Shape): number {
  switch (shape.kind) {
    case "circle":
      return Math.PI * shape.radius ** 2;
    case "square":
      return shape.side ** 2;
    case "rectangle":
      return shape.width * shape.height;
    case "triangle":
      return 0.5 * shape.base * shape.height;
    default: {
      // If a new variant is added without a case, this errors at compile time.
      const _exhaustive: never = shape;
      throw new Error(`unhandled shape: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Network message protocol — narrowed via the `type` discriminator. */
export type Message =
  | { type: "ping"; sentAt: number }
  | { type: "pong"; replyTo: number; rttMs: number }
  | { type: "text"; body: string; from: string }
  | { type: "close"; reason?: string };

export interface MessageHandlers {
  onPing?(msg: Extract<Message, { type: "ping" }>): void;
  onPong?(msg: Extract<Message, { type: "pong" }>): void;
  onText?(msg: Extract<Message, { type: "text" }>): void;
  onClose?(msg: Extract<Message, { type: "close" }>): void;
}

export function dispatch(msg: Message, handlers: MessageHandlers): void {
  switch (msg.type) {
    case "ping":
      handlers.onPing?.(msg);
      return;
    case "pong":
      handlers.onPong?.(msg);
      return;
    case "text":
      handlers.onText?.(msg);
      return;
    case "close":
      handlers.onClose?.(msg);
      return;
  }
  // Exhaustiveness fallthrough — should be unreachable.
  const _check: never = msg;
  void _check;
}

/** Narrowing via the `in` operator. */
export interface HasUserId { userId: string; }
export interface HasGuestId { guestId: string; }
export type Caller = HasUserId | HasGuestId;

export function callerLabel(caller: Caller): string {
  if ("userId" in caller) {
    return `user:${caller.userId}`;
  }
  return `guest:${caller.guestId}`;
}

/** Try/catch wrapper that returns a Result rather than throwing. */
export function tryCatch<T>(fn: () => T): Result<T> {
  try {
    return ok(fn());
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
