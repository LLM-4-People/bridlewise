/**
 * THE ONE PROCESS BOOTSTRAP — every process entry point calls
 * `bootstrapProcess({ role })` before it does anything (SCALE-CR1-FIX H2).
 *
 * It does two things, in this order:
 *
 *  1. installs the ONE process fault policy for the process's role
 *     (`src/process/fault-policy.ts`): a CLI (`role: "cli"`) fails closed on a
 *     lost rejection or a guarded callback fault (exit 70), so a gate whose
 *     failure surfaced only as an unawaited rejection can never pass;
 *  2. configures CENTRAL LOGGING. The debug system is a no-op until a host
 *     configures it, and only the web server's bridge did: every event the
 *     engine's own tools emit — a journaled transaction rolled back or
 *     recovered, abandoned temporaries swept, a reported failure — went
 *     nowhere in the commit guard, the candidate tool, the test inventory, the
 *     test runner and the harness CLI (wf1b-design M4, reproduced: a swept
 *     dead owner's directory, nothing emitted). This configures the SAME
 *     system from the SAME document section the server reads (`debug`), so an
 *     audit event reaches stderr through the declared console sink in every
 *     process. Idempotent: a host that already configured the system (the
 *     server) keeps its own configuration.
 *
 * It reads the section through the config owner's DATA-form inspection and
 * NEVER throws: a settings file the tool itself refuses is reported by the
 * tool, typed, on its own channel (a bootstrap that threw first replaced
 * that typed line with a stack), and logging then runs on the declared
 * defaults — audit on, redaction on, the console sink: the floor, never
 * weaker than any document could make it. A present section that fails the
 * debug schema or its safety floor gets the same defaults.
 *
 * Called at PROCESS ENTRY only (a module's main guard — ONE spelling,
 * `if (isEntryPoint(import.meta.url)) { bootstrapProcess({ role: "cli" }); … }`
 * — or a top-level program), never from a library: both steps are
 * process-wide, and a test process that imports a tool must keep its own
 * state. Worker THREADS take the policy from the one worker spawn
 * (`src/process/worker-bootstrap.ts`), the web server from its first import.
 * `test/runtime/cli-debug.test.ts` and `tests/prevention/guarded-callbacks.test.ts`
 * refuse an entry point or a worker that bypasses them.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { engineConfigDocumentPath, inspectConfigDocument } from "../kernel/config.ts";
import { DEBUG_CONFIG_DEFAULTS, DEBUG_CONFIG_SCHEMA, debugConfigViolations, resolveDebugConfigSection, type DebugConfig } from "../shared/debug/debug-config.ts";
import { configureDebugSystem, createConsoleSink, isDebugSystemConfigured } from "../shared/debug/debug-system.ts";
import { installProcessFaultPolicy, type ProcessFaultRole } from "../process/fault-policy.ts";

/** The debug section a CLI process runs on (see the header): the document's, or the declared defaults. */
function cliDebugConfig(): DebugConfig {
  const inspection = inspectConfigDocument(engineConfigDocumentPath());
  const section = inspection.state === "ok" ? inspection.document["debug"] : undefined;
  const parsed = DEBUG_CONFIG_SCHEMA.safeParse(section);
  if (!parsed.success || debugConfigViolations(parsed.data).length > 0) return { ...DEBUG_CONFIG_DEFAULTS };
  return resolveDebugConfigSection(parsed.data) ?? { ...DEBUG_CONFIG_DEFAULTS };
}

export function bootstrapProcess(options: Readonly<{ role: ProcessFaultRole }>): void {
  installProcessFaultPolicy(options);
  if (isDebugSystemConfigured()) return;
  const config = cliDebugConfig();
  configureDebugSystem(config, config.sinks.enabledSinks.includes("console") ? [createConsoleSink()] : []);
}

/**
 * THE ONE MAIN-NESS TEST: whether the module at `moduleUrl` (its
 * `import.meta.url`) is the program node was asked to run. Compared by real
 * path, so a symlinked or relative invocation is still the program (the
 * twelve private spellings this replaced disagreed on exactly that: a
 * `file://${argv[1]}` spelling was false for a relative path, and every
 * spelling but one for a symlink). The engine's entry-point guard
 * (`test/runtime/cli-debug.test.ts`) refuses any other spelling, so every
 * entry point is found and runs the process bootstrap first.
 */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (argv1 === undefined || argv1.length === 0) return false;
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      // Not on disk (an eval, a vanished file): its own spelling is the answer.
      return path;
    }
  };
  return real(resolve(argv1)) === real(fileURLToPath(moduleUrl));
}
