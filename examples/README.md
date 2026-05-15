# examples/

Real-world TypeScript code used to stress-test Strata's ingest → store → render → verify pipeline. These are not toys; they have logic, cross-references, and the full spread of TypeScript idioms we expect the substrate to round-trip without loss.

Two suites:

- **`small/`** — four standalone files, each ~100 LOC, each exercising a different cluster of language features. Useful for fast unit-level round-trip checks.
- **`medium/`** — a 6–12 file project (an in-memory key-value store with TTLs, LRU eviction, JSON persistence, and a tiny CLI). Useful for cross-module round-trip and reference-resolution work.

No third-party dependencies. Node built-ins only. No JSX, no decorators.

## `small/`

Each file is self-contained, ends with at least one `export`, includes meaningful comments, and is real code (not a syntax demo).

| File | LOC | What it exercises |
|---|---:|---|
| `classes-and-interfaces.ts` | 120 | interfaces, abstract class, inheritance, accessors (get/set), static members, readonly fields, protected access, `implements`, constructor parameter properties, `override` |
| `generics-and-types.ts` | 92 | generic functions/classes, conditional types, mapped types with key remapping, template literal types, `infer`, `const` type params, default type params, type guards, assertion functions |
| `async-and-iterators.ts` | 105 | async/await, async generators, `for await...of`, `Promise.all` / `Promise.race`, `AbortController`, retry with backoff, concurrency-limited map |
| `unions-and-discriminated.ts` | 101 | discriminated unions, exhaustive `switch` with `never`, `Result` types, `Extract`, narrowing via the `in` operator, type predicates |

### Type-checking a single small file

The files import from Node built-ins (`node:crypto`, `node:timers/promises`), so the type-checker needs Node's type definitions on the search path. The CLAUDE.md ground rule is "no installs into the repo," so do this from a scratch directory:

```sh
mkdir -p /tmp/strata-typecheck && cd /tmp/strata-typecheck
[ -d node_modules ] || (npm init -y >/dev/null && npm install --silent typescript@latest @types/node)
./node_modules/.bin/tsc \
  --noEmit --strict \
  --target es2022 --module esnext --moduleResolution bundler \
  --types node \
  /path/to/Strata/examples/small/classes-and-interfaces.ts
```

For a file that uses no Node built-ins (`generics-and-types.ts`, `unions-and-discriminated.ts`), the `--types node` flag can be dropped and a plain `npx -y typescript@latest tsc --noEmit --strict --target es2022 --module esnext --moduleResolution bundler <file>` works.

## `medium/`

A small but realistic project: a typed, in-memory key-value store with TTL, LRU eviction, tag-based invalidation, a typed event bus, JSON file persistence, and a tiny argv-parsed CLI.

```
medium/
├── package.json          # name + type:module, no deps
├── tsconfig.json         # strict, es2022, bundler resolution, .ts imports
└── src/
    ├── types.ts          # shared types: Entry, StoreEvent, Clock, etc.
    ├── clock.ts          # ManualClock for deterministic tests
    ├── events.ts         # tiny typed EventBus
    ├── lru.ts            # ordered key tracker for LRU eviction
    ├── store.ts          # KvStore<V> — the core
    ├── persistence.ts    # atomic JSON save / load
    ├── flags.ts          # minimal argv parser
    ├── cli.ts            # command dispatch on top of KvStore<string>
    ├── main.ts           # process entry point
    └── index.ts          # public re-export surface
```

| File | LOC |
|---|---:|
| `types.ts` | 63 |
| `clock.ts` | 37 |
| `events.ts` | 36 |
| `lru.ts` | 42 |
| `store.ts` | 224 |
| `persistence.ts` | 37 |
| `flags.ts` | 67 |
| `cli.ts` | 163 |
| `main.ts` | 26 |
| `index.ts` | 26 |
| **total** | **721** |

Files import each other (e.g. `cli.ts` → `flags.ts`, `persistence.ts`, `store.ts`; `index.ts` → everything), so the project exercises cross-module reference resolution.

### Type-checking the medium project

The project uses `.ts` import specifiers (matching the Strata design's bundler/`tsx`-style stance), so `allowImportingTsExtensions` is on in its `tsconfig.json`. The compiler needs `@types/node` reachable; we don't install it into the repo, so point `--typeRoots` at the scratch install:

```sh
mkdir -p /tmp/strata-typecheck && cd /tmp/strata-typecheck
[ -d node_modules ] || (npm init -y >/dev/null && npm install --silent typescript@latest @types/node)

cd /path/to/Strata/examples/medium
/tmp/strata-typecheck/node_modules/.bin/tsc \
  --noEmit -p . \
  --typeRoots /tmp/strata-typecheck/node_modules/@types
```

Expected output: nothing (exit 0).

## Why these examples

The intent is that round-trip bugs in `packages/ingest` and `packages/render` should *fail loudly* against this directory, not silently pass against a toy snippet. If a round-trip CLI from Phase 0 can parse-render-typecheck every file under `examples/` without diagnostics drift, that's a real signal — these files hit nearly every common TypeScript construct.

When new features land in `ingest` / `render` (e.g. decorator support, JSX, async-iterator method shorthand), add a new file here that exercises them before relying on the change in the wider system.
