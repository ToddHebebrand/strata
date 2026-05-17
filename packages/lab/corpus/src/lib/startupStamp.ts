import { formatTimestamp } from "./format.ts";

/** Returns a fixed startup-epoch label (epoch 0) as an ISO string. */
export function startupStamp(): string {
  return formatTimestamp(0);
}
