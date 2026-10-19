/**
 * The web server's process fault policy, installed FIRST (server/index.ts
 * imports this before anything else, the settings preflight included), so a
 * fault in any later module's load or in the boot's top-level awaits is
 * already handled by the one owner (`engine/src/process/fault-policy.ts`,
 * SCALE-CR1 C2): an unhandled rejection is counted and logged and the server
 * lives; an uncaught exception records a `process-fault` event in the ledger
 * (once the timeline bridge registers its recorder) and exits 70 for the
 * supervisor. This module imports only the policy, so installing it loads no
 * module that reads settings at load.
 */
import { installProcessFaultPolicy } from "../../engine/src/process/fault-policy.ts";

installProcessFaultPolicy({ role: "server" });
