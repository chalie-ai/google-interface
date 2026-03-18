/**
 * Shared utility for resolving the daemon's persistent data directory.
 *
 * The Chalie Agent SDK parses `--data-dir` internally and does not expose
 * the value to daemon code. This module provides a single authoritative
 * implementation that reads `Deno.args` directly, supporting both argument
 * forms:
 *
 *   --data-dir ./foo          (space-separated)
 *   --data-dir=./foo          (equals-separated)
 *
 * All modules that read or write persistent state (auth.ts, sync/*, settings.ts)
 * must import `getDataDir()` from here. Do not duplicate argument-parsing logic.
 *
 * @module
 */

/**
 * Resolve the data directory from command-line arguments.
 *
 * Parsing rules (evaluated in order):
 * 1. If `--data-dir <value>` is present (space-separated), return `<value>`.
 * 2. If `--data-dir=<value>` is present (equals-separated), return `<value>`.
 * 3. Otherwise return the default fallback: `"./data"`.
 *
 * @returns {string} Absolute or relative path to the data directory.
 *
 * @example
 * // deno run daemon.ts --data-dir=/var/chalie/data
 * getDataDir(); // => "/var/chalie/data"
 *
 * @example
 * // deno run daemon.ts --data-dir ./local-data
 * getDataDir(); // => "./local-data"
 *
 * @example
 * // deno run daemon.ts  (no --data-dir flag)
 * getDataDir(); // => "./data"
 */
export function getDataDir(): string {
  // Form 1: --data-dir <value>  (space-separated, value is the next argument)
  const spaceIdx = Deno.args.indexOf("--data-dir");
  if (spaceIdx !== -1) {
    const value = Deno.args[spaceIdx + 1];
    if (value !== undefined && value !== "" && !value.startsWith("-")) {
      return value;
    }
  }

  // Form 2: --data-dir=<value>  (equals-separated, value is embedded in the flag)
  const eqArg = Deno.args.find((arg) => arg.startsWith("--data-dir="));
  if (eqArg !== undefined) {
    const value = eqArg.slice("--data-dir=".length);
    if (value !== "") {
      return value;
    }
  }

  // Fallback default
  return "./data";
}
