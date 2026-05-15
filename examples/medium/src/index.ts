// Library entrypoint. Re-exports the public surface so consumers can
// `import { KvStore } from "@strata-examples/medium-kvstore"` without
// reaching into individual files.

export { KvStore, type StoreOptions } from "./store.ts";
export { ManualClock } from "./clock.ts";
export { EventBus, type Listener } from "./events.ts";
export { LruIndex } from "./lru.ts";
export { loadFromFile, saveToFile } from "./persistence.ts";
export { runCli, type CliEnv } from "./cli.ts";
export {
  FlagParseError,
  numberOption,
  parseArgs,
  type ParsedArgs,
} from "./flags.ts";
export {
  systemClock,
  type Clock,
  type Entry,
  type Millis,
  type PutOptions,
  type SnapshotShape,
  type StoreEvent,
  type StoreStats,
} from "./types.ts";
