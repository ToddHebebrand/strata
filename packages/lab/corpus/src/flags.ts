// Tiny argv parser used by the CLI.
// Supports `--flag value`, `--flag=value`, `--bool`, and positional args.
// No third-party deps; intentionally minimal.

export interface ParsedArgs {
  command: string;
  positional: string[];
  options: Record<string, string | boolean>;
}

export class FlagParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlagParseError";
  }
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new FlagParseError("expected a command (run with --help for usage)");
  }

  const [command, ...rest] = argv;
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eqIndex = body.indexOf("=");
    if (eqIndex >= 0) {
      const name = body.slice(0, eqIndex);
      const value = body.slice(eqIndex + 1);
      options[name] = value;
      continue;
    }
    // Bare flag — look ahead for a value, otherwise treat as boolean.
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      options[body] = true;
    } else {
      options[body] = next;
      i++;
    }
  }

  return { command: command!, positional, options };
}

/** Convenience: pull a numeric option, with a default. */
export function numberOption(
  args: ParsedArgs,
  name: string,
  fallback: number,
): number {
  const raw = args.options[name];
  if (raw === undefined || raw === true) return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new FlagParseError(`--${name} expected a number, got "${raw}"`);
  }
  return parsed;
}
