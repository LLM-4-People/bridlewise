/**
 * LANDLOCK RUNNER — the web server's bridge to the harness's self-protection
 * guardian.
 *
 * ── WHAT THIS PROTECTS, AND WHY IT IS THIS AND NOT THE CHAT STREAM ────────
 *
 * The web server runs the model's `execute_command` tool by spawning a child
 * process in the project directory. That child, and every stdio MCP server
 * (whose tool arguments — paths, commands, queries — are also chosen by the
 * model, which makes the server a model-directed proxy), are the things in
 * this server the model can point at arbitrary bytes on the disk: unconfined,
 * each inherits the server's own filesystem authority, so a request the model
 * chose can read a private key three directories up, or write into the
 * harness's own `src/`. An MCP server is confined to a harness-owned home of
 * its own (`mcpServerHomeDir`) — never the project: project file effects go
 * only through the governed native tools.
 * `spawnAsyncSafe` in `server/tool-executor.ts` already says so in as many
 * words — "a spawned command may write files, and those writes never cross
 * the editor bridge's file-effect choke point".
 *
 * Landlock closes exactly that. The guardian restricts ITSELF to a compiled
 * spec and then `execvp`s the payload; the restriction is irrevocable and is
 * inherited across every fork and exec the payload performs. So the model's
 * command runs able to read and write the selected project and nothing else.
 *
 * An earlier experiment attached this to the LLM stream instead — it spawned
 * a sandboxed worker whose whole job was one outbound HTTPS request. That
 * sandboxes a process which touches no project file, while the process that
 * does touch project files keeps full authority; and it would have opened a
 * second path to the model that skipped `streamChat`, which is the single
 * choke point where every prompt is redacted and deduplicated. The sandbox
 * belongs on the process that holds the dangerous authority, which is this
 * one.
 *
 * ── EVERY LANDLOCK DECISION IS THE HARNESS'S, NOT THIS FILE'S ─────────────
 *
 * Nothing here knows what a Landlock flag is. The harness owns:
 *   - `resolveSelfProtectionConfig` — what the operator asked for;
 *   - `compileSelfProtectionConfigToSpec` — the operator's config plus the
 *     non-overridable floor in `ROOT_POLICY.selfProtection` becomes a spec;
 *   - `verifyGuardianBinaryAvailability` — binary present, its sha256 equal
 *     to the root-policy pin, and this kernel actually enforcing Landlock;
 *   - `canonicalJson` — the bytes of the spec file.
 * This module decides only WHERE the result is applied and WHAT HAPPENS when
 * it cannot be.
 *
 * ── THERE IS NO FALL-THROUGH TO UNCONFINED ────────────────────────────────
 *
 * When the operator has asked for self-protection and the guardian is not
 * usable, `prepareConfinedSpawn` returns `refused` and the command does not
 * run. It does not run "with a warning". A warning next to a command that
 * already ran unconfined is a description of the breach, not a defence, and
 * the run would have gone on to report success. Deny by default: the only
 * way to reach an unconfined spawn is for the config to say, in writing, that
 * self-protection is off — and then the status says so too, rather than
 * implying protection that is not there.
 */

import { execFile, spawn, spawnSync, type ExecFileException, type SpawnSyncReturns } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  canonicalJson,
  classifyGuardianResult,
  compileSelfProtectionConfigToSpec,
  createOwnedTemporaryDirectory,
  removeOwnedTemporaryDirectory,
  DEFAULT_TEMP_DIR_ACCESS,
  guarded,
  guardianNoticeLinePattern,
  PROJECT_ROOT_ACCESS_FLAGS,
  resolveGuardianBinaryPath,
  resolveLocation,
  staysWithinRegion,
  verifyGuardianBinaryAvailability,
  type GuardianBinaryAvailability,
  type LandlockAccessFsFlagName,
  type SelfProtectionConfig,
} from "../kernel/canonical.ts";
import { harnessRoot, serverKeepOutFacts, type ConfinedSpawnPurpose } from "./host-facts.ts";
import { HarnessError } from "../../engine/src/kernel/errors.ts";
import { withPrivateTemporary } from "../../engine/src/process/environment-projection.ts";
// The four confinement states are declared once, in the shared wire-shape
// owner, because the cockpit renders exactly the set this file can report.
import type { ConfinementState } from "../../shared/wire-types.ts";
import { inheritedEnvironment, serverConfig } from "../kernel/config.ts";
import { sha256, sha256OfBytes } from "../kernel/digest.ts";
import { CONFIG_UNREADABLE_CODE, getSelfProtectionConfig } from "../kernel/harness-config.ts";
import { webWarn } from "../observability/debug-bridge.ts";
import { registerComponent } from "../observability/component-registry.ts";
import { ServiceUnavailableError, ValidationError } from "../kernel/errors.ts";

// ── Status ────────────────────────────────────────────────────────────────

/**
 * What the harness can honestly say about confinement right now.
 *
 * FOUR states, not two, because "not confined" and "cannot tell" are
 * different facts and collapsing them is how a status starts lying:
 *
 *   off         — the operator has not turned self-protection on. Commands
 *                 run with the server's own authority, and this says so.
 *   confined    — measured available. Commands are restricted to the project.
 *   unavailable — turned on, and measurably NOT available (no binary, wrong
 *                 binary, no Landlock on this kernel, not Linux). Commands
 *                 are refused.
 *   unknown     — turned on, and the probe itself could not complete. Also
 *                 refused, because a question that could not be answered is
 *                 not a yes.
 */
export type { ConfinementState };

export type SelfProtectionStatus = Readonly<{
  state: ConfinementState;
  /** One plain sentence, no internal vocabulary — this is user-facing. */
  sentence: string;
  /** Why it is in this state, naming the inputs that decided it. */
  reason: string;
  /** epoch ms of the measurement behind this answer. */
  measuredAt: number;
  /** The kernel's Landlock generation, when it was measured. */
  kernelAbi: number | null;
  /** The sha256 of the guardian actually found, when one was. */
  guardianSha256: string | null;
  /** The harness's own code for an unavailability, or null. */
  code: string | null;
}>;

/**
 * Plain-words consequence of each availability failure. Written for someone
 * who has never heard of Landlock: what is true, and what to do about it.
 */
type GuardianUnavailableCode = Extract<GuardianBinaryAvailability, { available: false }>["code"];

function unavailabilitySentence(code: GuardianUnavailableCode): string {
  switch (code) {
    case "binary_missing":
      return "Confinement is turned on but the program that enforces it is not built, so commands are refused rather than run with full access to this machine.";
    case "binary_hash_mismatch":
      return "Confinement is turned on but the program that enforces it does not match the version this harness expects, so commands are refused.";
    case "landlock_unavailable":
      return "Confinement is turned on but this computer's operating system will not enforce it, so commands are refused.";
    case "platform_unsupported":
      return "Confinement is turned on but it only works on Linux, so commands are refused on this computer.";
    default: {
      // Unrepresentable rather than defaulted: if the harness adds a fifth
      // failure code, this stops compiling instead of quietly describing it
      // with someone else's sentence.
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

/**
 * The availability probe spawns the guardian several times (once to check it
 * runs, then once per Landlock generation to find the kernel's), so it is far
 * too expensive for the per-command path. It is cached on the IDENTITY OF THE
 * BINARY — the sha256 of its CONTENT — rather than on a timer: rebuild the
 * guardian and the next command re-probes, leave it alone and nothing is
 * re-spawned. A stale answer is therefore not reachable by waiting, which a
 * time-to-live would have made reachable by construction.
 *
 * THE KEY IS THE CONTENT, AND IT WAS THE SIZE AND THE MODIFICATION TIME. Both
 * of those are attacker-settable: a replacement of the same length with the
 * timestamp restored produced the same key, so the process kept answering
 * "verified" for a binary it had never seen, and the root-policy sha256 pin —
 * which is only consulted on a cache MISS — was never asked. The comment here
 * claimed a stale answer was unreachable, which was true of waiting and not of
 * content. Hashing 30 KB is nothing beside the process this cache exists to
 * avoid starting.
 */
type ProbeCacheEntry = Readonly<{
  key: string;
  availability: GuardianBinaryAvailability | null;
  failure: string | null;
  measuredAt: number;
}>;

let probeCache: ProbeCacheEntry | null = null;

/**
 * Identity of the guardian binary at `root`, or its absence.
 *
 * NUL-separated, written as the source escape so the file stays scannable by
 * tools that sniff for binary content. A space would not do: a path may
 * contain one, and two different worlds could then produce the same key —
 * which for a cache whose miss means "re-check whether this machine can
 * enforce anything" is the wrong kind of collision.
 */
function binaryIdentity(root: string): string {
  const path = resolveGuardianBinaryPath(root);
  if (path === undefined) return `${root}\0absent`;
  try {
    return `${root}\0${path}\0${sha256OfBytes(readFileSync(path))}`;
  } catch {
    // A key that can never equal a previous one, so an unreadable binary
    // always re-probes rather than reusing whatever was measured last.
    return `${root}\0${path}\0unreadable\0${Date.now()}\0${Math.random()}`;
  }
}

/** Drop the cached probe. Exported so a test can measure a changed world. */
export function invalidateGuardianProbe(): void {
  probeCache = null;
}

/**
 * Probe the guardian, through the cache. Never throws: a probe that blows up
 * is reported as a failure string, which the caller turns into `unknown` —
 * and `unknown` refuses, so a broken probe cannot become permission.
 */
function probeGuardian(root: string): ProbeCacheEntry {
  const key = binaryIdentity(root);
  const cached = probeCache;
  if (cached !== null && cached.key === key) return cached;
  let entry: ProbeCacheEntry;
  try {
    entry = {
      key,
      availability: verifyGuardianBinaryAvailability(root),
      failure: null,
      measuredAt: Date.now(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    webWarn("landlock", "guardian availability probe failed", () => ({ root, error: message }));
    entry = { key, availability: null, failure: message, measuredAt: Date.now() };
  }
  probeCache = entry;
  return entry;
}

/**
 * WHAT CONFINEMENT ACTUALLY GIVES YOU, SAID IN FULL.
 *
 * This used to read "they cannot read or change anything else on this
 * computer", and that was measurably false in five ways at once. From inside
 * the sandbox a command can still READ the system directories every program
 * needs to start — `/usr`, `/etc`, `/lib`, `/proc`, `/dev` are all in the
 * safety floor's allow-set, deliberately, because a sandbox that removes them
 * removes the ability to run anything. It can also see and signal other
 * programs this server started, because the Landlock generation on ordinary
 * kernels governs the filesystem and nothing else. And it can use the network,
 * which no filesystem rule touches at all.
 *
 * A security claim wider than the measurement is a fabrication in prose, and
 * it is the more dangerous kind, because the reader relies on it in exactly
 * the situation where they cannot check. §11 asks for no required knowledge,
 * which this keeps — no Landlock, no allow-rules, no vocabulary — but §5
 * forbids buying that plainness with a claim that is not true.
 *
 * So the sentence names what is protected (your files), what is not (system
 * programs, other programs this server is running, the network), and stops.
 * One owner, because the cockpit and the tool result must not be able to
 * describe the same fact differently.
 */
/*
 * ── AND IT WAS FALSE AGAIN, IN A NEW WAY ──────────────────────────────────
 *
 * "Your other files, your other projects and the rest of your disk are out of
 * reach" was refuted twice after it was written. A symbolic link planted at
 * the project's scratch folder widened the NEXT command's allow-set to
 * `~/.ssh`; that is closed. What is NOT closed, and cannot be from here, is a
 * SECOND NAME for an outside file already sitting inside the project: Landlock
 * authorises by path hierarchy, so a hard link inside the project genuinely
 * reads the file it points at, wherever that file lives. The confined process
 * cannot create one — the kernel refuses a cross-hierarchy link — but package
 * managers and `git clone --local` create them all the time, so a project can
 * arrive with one already in it.
 *
 * A sentence has to be true of the world it is shown in, so it names that
 * condition in words nobody needs a manual for. This is not hedging: it is the
 * difference between a claim the reader can rely on and one that happens to
 * hold today.
 */
export const CONFINED_SENTENCE =
  "Commands the model runs can only reach files through the project folder you selected. "
  + "Anything elsewhere on your disk — your other projects, your home folder, your keys — is out of reach, unless a second name for one of those files was already placed inside the project folder before you opened it. "
  + "They can still read the system programs they need in order to run, see and signal the other programs this server started, and use the network.";

/**
 * The confinement status, measured. Every field is either a real measurement
 * or an explicit null — there is no field here that reports a guess.
 */
export function selfProtectionStatus(): SelfProtectionStatus {
  let config: SelfProtectionConfig;
  try {
    config = getSelfProtectionConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      state: "unknown",
      sentence:
        "Whether commands are confined to this project cannot be determined, so commands are refused.",
      reason: `The self-protection settings could not be read: ${message}`,
      measuredAt: Date.now(),
      kernelAbi: null,
      guardianSha256: null,
      code: CONFIG_UNREADABLE_CODE,
    };
  }
  // DENY BY DEFAULT, AND THE DEFAULT IS THE ABSENCE OF A SETTING. An absent
  // `selfProtection` section resolves to CONFINED at its one owner
  // (`resolveSelfProtectionConfig`, shared with the engine), so only an
  // operator's written `enabled: false` is "off" — a fresh install, a
  // trimmed config or a section lost in a merge cannot remove the sandbox.
  if (!config.enabled) {
    return {
      state: "off",
      sentence:
        "Commands the model runs are NOT confined — they can read and write anywhere this server can.",
      reason:
        "Self-protection is turned off in the harness settings (selfProtection.enabled is false). Turn it on to confine every command to the selected project.",
      measuredAt: Date.now(),
      kernelAbi: null,
      guardianSha256: null,
      code: null,
    };
  }
  const root = harnessRoot();
  const probe = probeGuardian(root);
  if (probe.availability === null) {
    return {
      state: "unknown",
      sentence:
        "Whether commands are confined to this project cannot be determined, so commands are refused.",
      reason: `Self-protection is on (it is on unless the settings turn it off), but checking it failed: ${probe.failure ?? "no reason recorded"}`,
      measuredAt: probe.measuredAt,
      kernelAbi: null,
      guardianSha256: null,
      code: "probe_failed",
    };
  }
  if (!probe.availability.available) {
    return {
      state: "unavailable",
      sentence: unavailabilitySentence(probe.availability.code),
      reason: `Self-protection is on (it is on unless the settings turn it off) and the check reported '${probe.availability.code}' for ${root}.`,
      measuredAt: probe.measuredAt,
      kernelAbi: null,
      guardianSha256: null,
      code: probe.availability.code,
    };
  }
  return {
    state: "confined",
    sentence: CONFINED_SENTENCE,
    reason: `Self-protection is on (turning it off has to be written into the settings) and was verified against ${root}.`,
    measuredAt: probe.measuredAt,
    kernelAbi: probe.availability.kernelAbi,
    guardianSha256: probe.availability.sha256,
    code: null,
  };
}

// ── The per-command decision ──────────────────────────────────────────────

/**
 * What to spawn, and under what authority.
 *
 * A discriminated union rather than a nullable wrapper, because the third
 * outcome is a REFUSAL and a nullable wrapper has nowhere to put one — the
 * caller would have had to remember that a null means "go ahead unconfined",
 * which is exactly the forgetting this shape makes impossible.
 */
export type ConfinedSpawn =
  | Readonly<{
    kind: "unconfined";
    command: string;
    args: readonly string[];
    /** Why no confinement was applied — carried into the tool result. */
    reason: string;
    /** An MCP server keeps its own temp folder (`<home>/.tmp`) even unconfined; a command keeps the caller's. */
    temporaryDirectory?: string;
  }>
  | Readonly<{
    kind: "confined";
    /** The guardian; it restricts itself and then execs the real command. */
    command: string;
    args: readonly string[];
    /** The command the model actually asked for, for the record. */
    payload: string;
    /**
     * The child's PRIVATE temp folder (granted in its spec; the system temp
     * folder never is): `spawnPlanned` points `TMPDIR`/`TMP`/`TEMP` here —
     * a command's per-spawn folder, an MCP server's `<home>/.tmp`.
     */
    temporaryDirectory: string;
    projectRoot: string;
    /** Removes the spec file. Safe to call more than once. */
    release: () => void;
  }>
  | Readonly<{
    kind: "refused";
    /** The harness's own code, or one naming the step that failed here. */
    code: string;
    /** Plain words for the model and for the reader. */
    message: string;
  }>;

/**
 * WHO IS BEING CONFINED. A `command` (the model's `execute_command`, the
 * awareness checks, git) works IN a project: the project root and its private
 * scratch folder are writable, and the operator's `selfProtection` allow-rules
 * apply. An `mcp-server` is a long-lived model-directed proxy that works for
 * every chat and belongs to no project: its ONLY writable root is its own
 * harness-owned home (which is also its temp directory — `TMPDIR` points
 * inside it), it gets no scratch folder and none of the operator's command
 * allow-rules, and its read paths are held to the refused-roots list the host
 * passes (secret directories, the harness's own tree and state). Refusals are
 * worded for the consumer.
 */
export type { ConfinedSpawnPurpose };

export type ConfinedSpawnRequest = Readonly<{
  command: string;
  args: readonly string[];
  /** The root the command is allowed to read and write (an MCP server: its home). */
  projectRoot: string;
  /**
   * Extra programs and directories this command must be able to READ and
   * EXECUTE: named by the server for its own checks (the typecheck's `tsc`,
   * which lives in the server's install and not in the project) or by the
   * operator for an MCP server (`readPaths`, its installation). Never by the
   * model or the project.
   *
   * NEVER WRITABLE (W^X), AND ENFORCED BY THE HARNESS COMPILER'S FLOOR for
   * every rule of every consumer: no rule granting EXECUTE (a tool path, the
   * payload, the interpreter, an operator rule) may overlap one granting a
   * write flag — compared by identity, so a bind-mount alias cannot dodge it.
   */
  toolPaths?: readonly string[];
}> & (
  | Readonly<{ purpose?: "command" }>
  | Readonly<{ purpose: "mcp-server"; serverId: string }>
);

/**
 * The MCP host's door into the owner, in its own words: a server's HOME is
 * its only write root (the request's `projectRoot` slot), its `readPaths` the
 * read-and-run paths. What no read path may reach is the ONE keep-out list
 * (the floor, every home's stores, the key home and registered stores, and
 * this host's facts — `host-facts.ts`).
 */
export function prepareConfinedSpawnForMcpServer(request: Readonly<{
  serverId: string;
  command: string;
  args: readonly string[];
  home: string;
  readPaths: readonly string[];
}>): ConfinedSpawn {
  return prepareConfinedSpawn({
    purpose: "mcp-server", serverId: request.serverId, command: request.command, args: request.args,
    projectRoot: request.home, toolPaths: request.readPaths,
  });
}

/**
 * The compiler floor's refusal codes, in this owner's wire vocabulary (the
 * cockpit and the MCP status keep the codes they already speak).
 */
const FLOOR_REFUSAL_CODES: Readonly<Record<string, string>> = Object.freeze({
  self_protection_allow_rule_subsumes_protected_subtree: "project_is_harness_source",
  self_protection_allow_rule_under_protected_subtree: "project_is_harness_source",
  self_protection_temp_dir_subsumes_protected_subtree: "project_is_harness_source",
  self_protection_temp_dir_under_protected_subtree: "project_is_harness_source",
  self_protection_rule_overlaps_refused_path: "read_path_refused",
  self_protection_execute_overlaps_writable: "tool_path_overlaps_writable",
});

/**
 * The refusal, worded for its consumer and LOGGED ONCE HERE with its code —
 * the owner is the lowest point every confined spawn passes, so no consumer
 * can refuse silently.
 */
function refuse(request: ConfinedSpawnRequest, code: string, message: string): ConfinedSpawn {
  const mcp = request.purpose === "mcp-server" ? request : undefined;
  // The MCP transport prefixes its own "MCP server command … was not started:".
  const worded = mcp === undefined ? message : MCP_REFUSAL_SENTENCES[code] ?? message;
  webWarn("landlock", "confined spawn refused", () => ({ purpose: request.purpose ?? "command", code, ...(mcp !== undefined ? { serverId: mcp.serverId } : {}) }));
  return { kind: "refused", code, message: worded };
}

/** An MCP server's own sentence for the refusals whose command wording would mislead ("the selected project"). */
const MCP_REFUSAL_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  project_folder_missing: "The server's home folder could not be created or found.",
  project_is_harness_source: "One of the server's read paths is part of the harness's own program code, which no confined process may be granted. Remove it from readPaths.",
  payload_not_found: "The server's command was not found on this computer. Install the server and give its full path or put it on the PATH.",
});

/**
 * Decide how a model-directed command should be spawned.
 *
 * The three outcomes map one-to-one onto the status states: `off` gives
 * `unconfined` (and says so), `confined` gives `confined`, and BOTH
 * `unavailable` and `unknown` give `refused`. There is no fourth path and no
 * argument that reaches an unconfined spawn while self-protection is on.
 */
export function prepareConfinedSpawn(request: ConfinedSpawnRequest): ConfinedSpawn {
  // THE PROJECT FOLDER IS CHECKED FIRST, BEFORE ANYTHING IS BUILT FROM IT.
  //
  // A project can point at a folder that is no longer there — a scratchpad
  // that was wiped, a drive that is not mounted. Every path below uses it:
  // it becomes the child's working directory, and the confined path also
  // derives the spec and the scratch folder from it. A missing working
  // directory is the misleading one: `spawn` reports it as ENOENT naming the
  // PROGRAM, so a wiped project folder reads as "the confinement program is
  // missing" — a true error attached to the wrong cause, which sends the
  // person to rebuild a binary that was never the problem.
  //
  // So the folder is asked about up front, in plain words, with the way out —
  // re-point the project or choose another. It sits ahead of the confinement
  // status because the answer is the same in both worlds: with the folder
  // gone, nothing can run against it whether confinement is on or off, and
  // "off" is not a reason to report the same fault differently.
  if (!projectRootIsUsableDirectory(request.projectRoot)) {
    return refuse(request, "project_folder_missing",
      "The folder for the selected project could not be found on this computer, so the command was not run. "
      + "The folder may have been moved, renamed or deleted. Re-point the project to its folder, or choose a different project.");
  }
  const status = selfProtectionStatus();
  if (status.state === "off") {
    // Logged at the owner, once per spawn: an unconfined start is the
    // operator's decision, and it is never silent.
    webWarn("landlock", "confined spawn unconfined", () => ({ purpose: request.purpose ?? "command", reason: status.reason, ...(request.purpose === "mcp-server" ? { serverId: request.serverId } : {}) }));
    return {
      kind: "unconfined", command: request.command, args: request.args, reason: status.reason,
      ...(request.purpose === "mcp-server" ? { temporaryDirectory: mcpServerTemporaryDirectory(request.projectRoot) } : {}),
    };
  }
  if (status.state !== "confined") {
    return refuse(request, status.code ?? status.state, `${status.sentence} ${status.reason}`);
  }
  const root = harnessRoot();
  const binaryPath = resolveGuardianBinaryPath(root);
  if (binaryPath === undefined) {
    // The probe said available and the binary has since gone. Refuse — the
    // world changed under the measurement, and the safe reading of a
    // measurement that no longer holds is that it does not hold.
    invalidateGuardianProbe();
    return refuse(request, "binary_missing",
      "Confinement is turned on but the program that enforces it disappeared between the check and the command, so the command was not run.");
  }
  const payloadPath = resolveExecutable(request.command);
  if (payloadPath === null) {
    return refuse(request, "payload_not_found",
      `The command '${request.command}' was not found on this computer, so there is nothing to confine and nothing was run.`);
  }
  const mcpServer = request.purpose === "mcp-server";
  let specPath: string;
  let tempDir: string | undefined;
  let temporaryDirectory: string;
  try {
    // The scratch directory is created BEFORE the spec, because it is an
    // INPUT to it. See `specConfig`: the spec's temp-dir allow-rule is this
    // directory and not the shared one.
    tempDir = createOwnedTemporaryDirectory(tmpdir(), "harness-web-guardian-");
    // CREATED BY THIS SERVER, BEFORE THE SPEC IS BUILT. Its existence is then
    // never something the sandbox decides, and the allow-set no longer asks
    // the filesystem a question the sandbox could have arranged the answer to.
    // An MCP server has no project, so it has no scratch folder.
    if (!mcpServer) ensureProjectScratchDir(request.projectRoot);
    const spec = compileConfinedSpec(request, payloadPath, tempDir);
    // THE CHILD'S PRIVATE TEMP FOLDER, the one its spec grants: a command's
    // per-spawn folder (or the operator's `selfProtection.tempDir`), an MCP
    // server's `<home>/.tmp` (inside its only write root).
    temporaryDirectory = mcpServer
      ? mcpServerTemporaryDirectory(request.projectRoot)
      : spec.temp_dir ?? getSelfProtectionConfig().tempDir ?? tempDir;
    specPath = join(tempDir, "guardian-spec.json");
    writeFileSync(specPath, canonicalJson(spec), { mode: 0o600 });
  } catch (err) {
    // The per-spawn directory is removed on a refusal too — no spec leaks.
    if (tempDir !== undefined) removeOwnedTemporaryDirectory(tempDir);
    return floorRefusal(request, err);
  }
  let released = false;
  const specDir = tempDir;
  return {
    kind: "confined",
    command: binaryPath,
    args: ["apply", "--spec", specPath, "--exec", payloadPath, ...request.args],
    payload: request.command,
    projectRoot: request.projectRoot,
    temporaryDirectory,
    // Released at the child's terminal state; a plan nobody released is
    // removed when this process exits (the owned-temporary owner).
    release: () => {
      if (released) return;
      released = true;
      try {
        removeOwnedTemporaryDirectory(specDir);
      } catch (err) {
        webWarn("landlock", "spec cleanup failed", () => ({ tempDir: specDir, error: err instanceof Error ? err.message : String(err) }));
      }
    },
  };
}

/**
 * THE SPEC OF ONE SPAWN — the harness compiler over this consumer's derived
 * config, with the host's refused paths. W^X and the refused paths are the
 * compiler floor's, over every rule: a command writes its project, its
 * scratch folder and the operator's write rules; an MCP server writes its
 * home and nothing else (its temp directory IS the home).
 */
function compileConfinedSpec(request: ConfinedSpawnRequest, payloadPath: string, tempDir: string): ReturnType<typeof compileSelfProtectionConfigToSpec> {
  const config = getSelfProtectionConfig();
  return compileSelfProtectionConfigToSpec(
    request.purpose === "mcp-server"
      ? mcpServerSpecConfig(config, payloadPath, request.projectRoot, request.toolPaths ?? [])
      : specConfig(config, payloadPath, request.projectRoot, tempDir, request.toolPaths ?? []),
    harnessRoot(),
    request.projectRoot,
    // The INTERPRETER, which is a different binary from the payload and is
    // needed just as often. `npm` is a script whose first line is
    // `#!/usr/bin/env node`; confine it with only its own path allowed and
    // it dies with "env: 'node': Permission denied" before running a byte.
    // This is measured rather than guessed: it is the very interpreter this
    // server is running under, and it is the one `env node` finds on the
    // PATH the child inherits.
    process.execPath,
    serverKeepOutFacts(request.purpose),
  );
}

/**
 * A compile failure as this owner's refusal. A GUIDED STATE FOR THE CASES A
 * PERSON WILL ACTUALLY HIT, rather than the compiler's own vocabulary:
 * selecting the harness's own repository as the project (the sandbox cannot
 * hand write access to the code that enforces it), a grant on a refused path,
 * and a path that would be both writable and executable.
 */
function floorRefusal(request: ConfinedSpawnRequest, err: unknown): ConfinedSpawn {
  const message = err instanceof Error ? err.message : String(err);
  const floorCode = err instanceof HarnessError ? FLOOR_REFUSAL_CODES[err.code] : undefined;
  webWarn("landlock", "spec compilation failed", () => ({ projectRoot: request.projectRoot, error: message }));
  const who = request.purpose === "mcp-server" ? "server" : "command";
  if (floorCode === "project_is_harness_source") {
    return refuse(request, floorCode,
      "This folder holds the harness's own program code, so commands cannot be run against it — the sandbox is not allowed to give anything write access to the code that enforces the sandbox. Choose a different project folder.");
  }
  if (floorCode === "read_path_refused") {
    return refuse(request, floorCode,
      `A path this ${who} would be granted holds credentials, keys or the harness's own state, which no confined process is ever given, so nothing was run: ${message}`);
  }
  if (floorCode === "tool_path_overlaps_writable") {
    return refuse(request, floorCode,
      `A path the confined ${who} could execute is also one it could write — a path it can write must never also be one it can execute, so nothing was run: ${message}`);
  }
  return refuse(request, "spec_rejected",
    `Confinement is turned on but the rules for this project could not be prepared, so the command was not run: ${message}`);
}

/**
 * The SAVE-TIME question for a stdio MCP server's placement: would the floor
 * refuse its `readPaths` (or its command inside its own home)? The same
 * compile a spawn performs, so a registration the spawn would refuse is
 * refused when it is saved — never accepted and then failed at every start.
 */
export function mcpServerPlacementRefusal(entry: Readonly<{ id: string; command: string; readPaths: readonly string[] }>): Readonly<{ code: string; message: string }> | undefined {
  const request: ConfinedSpawnRequest = {
    purpose: "mcp-server", serverId: entry.id, command: entry.command, args: [],
    projectRoot: mcpServerHomeDir(entry.id), toolPaths: entry.readPaths,
  };
  try {
    compileConfinedSpec(request, resolveExecutable(entry.command) ?? process.execPath, request.projectRoot);
    return undefined;
  } catch (err) {
    const refused = floorRefusal(request, err);
    return refused.kind === "refused" ? { code: refused.code, message: refused.message } : undefined;
  }
}

/**
 * WHERE A PROJECT'S OWN SCRATCH FOLDER LIVES — one owner, so nothing has to
 * be kept in step.
 *
 * A project gets a writable scratch folder of its own, and the model is told
 * about it. That makes its presence in the allow-set a correctness
 * requirement, not a convenience: telling the model about a folder it cannot
 * write to is worse than not telling it, because it will try, fail, and have
 * no way to work out why. So it is derived here and consumed by the allow-set
 * derivation below — a first-class member, not something remembered.
 *
 * DERIVED FROM THE PROJECT, which is what makes it automatic: a project added
 * tomorrow gets its scratch folder in the allow-set with no edit anywhere,
 * because the allow-set asks this function rather than reading a list.
 *
 * IT SITS OUTSIDE THE PROJECT, and that is the whole point of the indirection.
 * It used to sit under the project root, which meant anything that could write
 * one symbolic link inside the project could aim the scratch rule somewhere
 * else — and a rule is a grant. It now lives under the harness's own state
 * directory, which no confined child holds any rule for: the parent directory
 * appears in no allow-rule, and every replacement attack against it —
 * rename, unlink, rmdir, sibling-mkdir, symlink, hard link, swap-up — is
 * refused by the kernel rather than by a check somebody could forget.
 *
 * THE CLAIM IN THIS PARAGRAPH IS ASSERTED, NOT ASSUMED. `projectScratchDir` is
 * driven against several project roots in the confinement owner's tests, which
 * require the answer to be outside the root it was given. A previous version
 * of this comment said the opposite of what the code does, for four commits,
 * and the only reason that was survivable is that nobody acted on it — a
 * reader who trusts a paragraph like this one can delete a real defence.
 */
export function projectScratchDir(projectRoot: string): string {
  // KEYED BY THE PROJECT, HELD BY THE HARNESS. The name is a hash of the
  // project root so it is stable for a project and cannot collide with
  // another; the DIRECTORY it lives in belongs to this server.
  return join(harnessScratchRoot(), sha256(projectRoot).slice(0, SCRATCH_KEY_HEX_CHARS));
}

/**
 * How much of the project hash names its scratch folder: 32 hex characters,
 * which is 128 bits. Truncated at all because a 64-character directory name is
 * unreadable in a listing, and at 128 bits because that is the point where a
 * collision between two projects on one machine stops being something anyone
 * needs to reason about. Not a configurable — changing it renames every
 * existing folder.
 */
const SCRATCH_KEY_HEX_CHARS = 32;

/** The one directory every project's scratch folder lives under. */
function harnessScratchRoot(): string {
  return join(harnessRoot(), ".bridlewise", "confined-scratch");
}

/**
 * THE HOME OF ONE STDIO MCP SERVER: its working directory, its `HOME`, and
 * the ONLY place its confined process may write. Held by the harness (under
 * the same state directory as the scratch folders, whose parent no confined
 * child holds a rule for), keyed by the server id — which the naming owner
 * restricts to letters, digits and inner hyphens, so it is a single safe
 * path segment.
 *
 * NOT THE PROJECT, deliberately: an MCP server is a model-directed proxy
 * running one process for every chat, and a write it made inside a project
 * would bypass the write set, the transactional editor, rollback and the
 * timeline's file-effect record. Project effects go only through the governed
 * native tools; an MCP server keeps its own state here.
 */
export function mcpServerHomeDir(serverId: string): string {
  return join(harnessRoot(), ".bridlewise", "mcp-home", serverId);
}

/**
 * Remove the home of an MCP server that was removed — its state, its
 * TMPDIR and any credential it cached go with the registration (a home left
 * behind outlived its server, and a later server given the same id would
 * inherit it). A link at the path is removed as a link, never followed.
 */
export function removeMcpServerHomeDir(serverId: string): void {
  const home = mcpServerHomeDir(serverId);
  if (lstatSync(home, { throwIfNoEntry: false }) === undefined) return;
  rmSync(home, { recursive: true, force: true });
  webWarn("landlock", "MCP server home removed with its registration", () => ({ serverId }));
}

/** Create (0700) the home of one stdio MCP server, refusing one that is not ours. */
export function ensureMcpServerHomeDir(serverId: string): string {
  return ensureHarnessOwnedDir(mcpServerHomeDir(serverId), "the home this server keeps for an MCP server");
}

/**
 * Create the scratch folder, and refuse to use one that is not ours.
 *
 * ── THE RULE THIS ENFORCES: A SPEC IS DERIVED ONLY FROM THINGS THE SANDBOX
 *    CANNOT TOUCH ─────────────────────────────────────────────────────────
 *
 * The scratch folder used to sit INSIDE the project, at
 * `<project>/.bridlewise/scratch`, and the allow-set was computed by asking
 * the filesystem about it. That is the whole defect, stated generally: an
 * allow-rule was derived from state the sandboxed process can WRITE. One
 * confined command replaced that path with a symbolic link to `~/.ssh`, and
 * the NEXT command's rules named the link's target — self-bootstrapping, with
 * no unconfined help at any point.
 *
 * Checking for the link afterwards is the losing move; the position to be in
 * is one where the input cannot be altered. So the folder MOVED OUT of the
 * project, into a directory this server owns. Nothing about it is reachable
 * from inside any sandbox:
 *
 *   - its PARENT is in no allow-rule, so a confined process cannot create,
 *     remove, rename or re-link the folder itself. Landlock authorises the
 *     directory operation against the parent, and the parent is not granted.
 *   - the folder is created HERE, by this server, before the spec is compiled,
 *     so its existence is never something the sandbox decides.
 *   - the NAME is derived from the project root the user chose, not read back
 *     from disk, so nothing on disk can change which folder a project gets.
 *
 * The confined command may still write inside it, which is the entire point;
 * it may even create links in there, and those links can only be followed to
 * places it was already allowed to reach, because the kernel authorises at
 * `open()` on the resolved path.
 *
 * IT IS STILL VERIFIED, and that is not belt-and-braces — it is the residual
 * this design cannot remove on its own. Something OUTSIDE the sandbox (a
 * person, another program running as the same user) could put a link there,
 * and the harness would then hand a confined command write access to wherever
 * it points. That is a strictly smaller claim than before — it needs authority
 * the sandbox does not have — and it is answered by refusing anything at that
 * path that is not a real directory.
 */
function ensureProjectScratchDir(projectRoot: string): string {
  return ensureHarnessOwnedDir(projectScratchDir(projectRoot), "the scratch folder this server keeps for the selected project");
}

/** The shared half of the two ensures above: create 0700, and refuse anything at the path that is not a real directory. */
function ensureHarnessOwnedDir(path: string, what: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory()) {
    throw new ServiceUnavailableError(
      `${what[0]!.toUpperCase()}${what.slice(1)} is not a folder any more (${path}). `
      + "Commands are not run until it is, because a link there would decide what a confined command may reach.",
      "self_protection_scratch_not_a_directory",
    );
  }
  return path;
}

/**
 * WHAT A CONFINED COMMAND MAY REACH — derived, in three parts, never authored.
 *
 * The allow-set is assembled from things that already know their own answer.
 * There is no list here for anyone to maintain, and that is the whole design:
 * a maintained path list fails silently and in the worst direction. A tool
 * added later works in development and dies under confinement; the person
 * debugging it widens the list to make it work; the restriction quietly stops
 * meaning anything. Nobody sees a failure, because widening is how the list is
 * meant to be used.
 *
 * The three origins, and where each is derived FROM:
 *
 *   runtime-and-tools  READ + EXECUTE. Three sources, all existing
 *                      declarations. `ROOT_POLICY.selfProtection.minimumAllowSet`
 *                      and `bundleRelativePath` are the harness's own floor,
 *                      applied by its compiler. The payload is resolved from
 *                      the same PATH the child is given, so confinement can
 *                      never allow a different binary than the child finds.
 *                      The interpreter prefix is computed from
 *                      `process.execPath` — the running process, not a value
 *                      anybody typed.
 *
 *   project-root       READ + WRITE. From the project record; it is the
 *                      folder the user selected.
 *
 *   project-scratch    READ + WRITE. From `projectScratchDir`, above.
 *
 * NOT A UNIFORM GRANT. The runtime paths are never writable, so a confined
 * command cannot alter the tools the next command will run — a flat allow-set
 * that gave everything to everything would be a weaker restriction wearing the
 * same shape. Anything from no origin at all is denied; there is no "looks
 * like a system path" arm.
 *
 * WHAT COULD NOT BE DERIVED, RECORDED AS THE STRENGTH LADDER REQUIRES: the
 * ACCESS SETS. `["EXECUTE", "READ_FILE"]` for a program and read/write for a
 * workspace are written here, because the harness exports
 * `PROJECT_ROOT_ACCESS_FLAGS` and `DEFAULT_TEMP_DIR_ACCESS` but has no
 * declaration for "what a program needs in order to be executed" — the floor
 * spells that inline too. It is two literals, not a path list, so it cannot
 * grow with the system the way a maintained allowlist would; the derivation
 * that matters — WHICH paths — has no literals in it at all.
 */
export type AllowOrigin = "runtime-and-tools" | "project-root" | "project-scratch";

export type DerivedAllowRule = Readonly<{
  origin: AllowOrigin;
  path: string;
  access: readonly ["EXECUTE", "READ_FILE"] | readonly ["READ_FILE", "READ_DIR", "EXECUTE"] | readonly string[];
}>;

export function deriveAllowRules(
  projectRoot: string,
  payloadPath: string,
  toolPaths: readonly string[] = [],
): readonly DerivedAllowRule[] {
  return [
    // The program being launched, resolved from the child's own PATH.
    { origin: "runtime-and-tools", path: payloadPath, access: ["EXECUTE", "READ_FILE"] },
    // The interpreter that program may need — measured from this process.
    { origin: "runtime-and-tools", path: interpreterPrefix(), access: ["EXECUTE", "READ_FILE", "READ_DIR"] },
    // Programs the SERVER named for this particular run — read and execute,
    // never write, so the same origin's access split applies to them without
    // an exception of their own.
    ...toolPaths.map((path) => ({
      origin: "runtime-and-tools" as const,
      path,
      access: ["READ_FILE", "READ_DIR", "EXECUTE"] as const,
    })),
    // The workspace the user chose, and the scratch folder that belongs to it.
    { origin: "project-root", path: projectRoot, access: [...PROJECT_ROOT_ACCESS_FLAGS] },
    { origin: "project-scratch", path: projectScratchDir(projectRoot), access: [...DEFAULT_TEMP_DIR_ACCESS] },
  ];
}

/**
 * WHICH DERIVED RULES ARE SAFE TO EMIT — one question here; presence is the
 * one compiler's (engine/src/filesystem/self-protection/guardian-binary.ts):
 * it judges every rule by NAME — the keep-out floor, W^X — and only then
 * emits the ones that exist, because a rule for a missing path makes the
 * guardian refuse the whole spec, while a path the floor refuses by name is
 * refused whether or not it exists yet. A presence test FOLLOWS LINKS, so a
 * link planted at a rule's path answers "there" about somewhere else — which
 * is how one confined command created `<project>/.bridlewise/scratch -> ~/.ssh`
 * and the next listed the private keys. That is the question asked here:
 *
 * DOES IT STILL POINT WHERE IT CLAIMS TO? `lstat` only sees a link at the
 *    LAST segment; `<project>/.bridlewise -> elsewhere` with a real
 *    directory inside it would pass. So every derived rule is resolved and
 *    checked against the project region with the harness's own comparison —
 *    the same one the compiler refuses on — and one that has wandered out is
 *    DROPPED rather than refused.
 *
 * DROPPED, NOT REFUSED, and the asymmetry is deliberate. A derived in-project
 * rule grants nothing the project-root rule does not already grant, so losing
 * it costs nothing; refusing would mean anything able to write a single
 * symbolic link could stop every command in that project from running, which
 * is a denial of service handed to the thing being confined. The compiler
 * still REFUSES the same shape when it arrives from an operator's own config,
 * because there a person wrote something wrong and has to be told.
 *
 * WHY `MAKE_SYM` IS STILL GRANTED ON THE PROJECT ROOT. Taking it away was
 * considered and rejected: `npm install` creates the symbolic links in
 * `node_modules/.bin`, so a project workspace without it is a workspace where
 * the ordinary first command fails. It is safe to grant BECAUSE of the two
 * checks above plus the kernel's own behaviour — Landlock authorises at
 * `open()` on the path the kernel resolves, so a link created inside the
 * project that points outside it cannot be FOLLOWED out either. What the link
 * could do was widen a RULE, and a rule is what this function now bounds.
 */
function emittableDerivedRules(
  rules: readonly DerivedAllowRule[],
  projectRoot: string,
): readonly DerivedAllowRule[] {
  const project = { raw: projectRoot, resolved: resolveLocation(projectRoot, "projectRoot") };
  return rules.filter((rule) => {
    // A PATH THAT IS NOT THERE IS NOT DROPPED HERE: the one compiler judges
    // every rule BY NAME (the keep-out floor refuses `~/.ssh` before it
    // exists) and only then emits the present ones
    // (engine/src/filesystem/self-protection/guardian-binary.ts). Dropping it
    // here hid a refused read path from that judgement until the folder
    // appeared.
    //
    // ONE QUESTION, ASKED OF EVERY DERIVED RULE: does it still point where it
    // claims to? The scratch folder is now out of the sandbox's reach, so this
    // is no longer load-bearing for it — but a tool path the server names, or
    // anything derived later, is not covered by that argument, and a rule
    // spelled inside the project must never resolve out of it.
    //
    // DROPPED, NOT REFUSED, and the asymmetry is deliberate: a derived
    // in-project rule grants nothing the project-root rule does not already
    // grant, so losing it costs nothing, while refusing would let anything
    // able to write one symbolic link stop every command in that project from
    // running. The compiler still REFUSES the same shape when it arrives from
    // an operator's own config, because there a person wrote something wrong
    // and has to be told.
    const resolved = resolveLocation(rule.path, `derived allow-rule (${rule.origin})`);
    if (staysWithinRegion(rule.path, resolved, project)) return true;
    webWarn("landlock", "derived allow-rule resolves outside the project and was dropped", () => ({ path: rule.path, resolved, origin: rule.origin }));
    return false;
  });
}

function specConfig(
  config: SelfProtectionConfig,
  payloadPath: string,
  projectRoot: string,
  scratchDir: string,
  toolPaths: readonly string[],
): SelfProtectionConfig {
  return {
    ...config,
    // THE HARNESS'S OWN CODE IN THIS REPOSITORY, protected alongside the
    // backend's. See `webServerSourceRoot` for why omission was not enough.
    // A PRIVATE SCRATCH DIRECTORY, NOT THE SHARED ONE — and this closes a
    // real hole rather than tidying one.
    //
    // The compiler needs somewhere the guardian can be handed its spec, and
    // its default is the system temp directory. That default grants the
    // confined child read AND WRITE over ALL of it. Two consequences, both
    // measured: a command confined to one project could read a second
    // project's files whenever both happened to live under the temp
    // directory, and every confined command everywhere could write anywhere
    // in a directory other processes read from — a shared writable surface
    // reachable from inside the sandbox, which is most of the way back out
    // of it.
    //
    // Naming a fresh per-command directory instead makes the allow-rule that
    // directory. The child still gets somewhere to write; nothing else on the
    // machine is in it, and it is removed when the command ends. An operator
    // who deliberately set `tempDir` keeps their choice.
    tempDir: config.tempDir ?? scratchDir,
    additionalAllowRules: [
      ...(config.additionalAllowRules ?? []),
      // DERIVED, not listed. The project root is already added by the
      // harness's compiler from its own argument, so what is added here is
      // everything the derivation produces that the compiler does not know
      // about; the compiler de-duplicates the overlap, so the derivation
      // stays the single statement of what may be reached.
      ...emittableDerivedRules(deriveAllowRules(projectRoot, payloadPath, toolPaths), projectRoot)
        .map((rule) => ({
          path: rule.path,
          access: rule.access as readonly LandlockAccessFsFlagName[],
        })),
    ],
  };
}

/**
 * THE SPEC OF A CONFINED MCP SERVER — its home is the only write root.
 *
 * Derived from the same owner as a command's (`deriveAllowRules`: the
 * payload, the interpreter, the read-and-run tool paths, the home as the
 * workspace), minus what belongs to a project or to the operator's command
 * policy: no project scratch folder, and none of `selfProtection`'s
 * `additionalAllowRules` (an operator who widens what COMMANDS may reach has
 * not widened every MCP server). The temp directory IS the home, so the
 * compiler emits no separate temp rule (it de-duplicates a temp directory
 * equal to an allow-rule), and the host points `TMPDIR` inside it. What stays
 * writable beyond the home is the safety floor's device files (`/dev`).
 */
function mcpServerSpecConfig(
  config: SelfProtectionConfig,
  payloadPath: string,
  home: string,
  toolPaths: readonly string[],
): SelfProtectionConfig {
  return {
    ...config,
    tempDir: home,
    additionalAllowRules: emittableDerivedRules(deriveAllowRules(home, payloadPath, toolPaths), home)
      .filter((rule) => rule.origin !== "project-scratch")
      .map((rule) => ({ path: rule.path, access: rule.access as readonly LandlockAccessFsFlagName[] })),
  };
}

/**
 * The install prefix of the interpreter this server runs under.
 *
 * THIS IS THE FLOOR'S OWN RULE, APPLIED TO A RELOCATED TOOLCHAIN — not a new
 * kind of permission. The floor already grants execute-and-read over `/usr`,
 * which is where a system-packaged Node lives; a Node installed by a version
 * manager sits under the user's home instead, and everything about it is the
 * same except the path. Without this, `npm` gets as far as executing and then
 * dies reading its own library, which is an outage wearing a security
 * message: the operator's rational response is to turn confinement off.
 *
 * DERIVED, NEVER TYPED IN. `<prefix>/bin/node` is the layout of every Node
 * distribution, so the prefix is two directories up from the running
 * executable — a fact measured from this process, not a path someone has to
 * keep in step with an upgrade. When Node IS under `/usr` this resolves to
 * `/usr`, the floor already names it, and the compiler's own de-duplication
 * drops the repeat.
 *
 * THE LAYOUT IS CHECKED, NOT ASSUMED, AND THAT IS THE BOUND. Climbing two
 * directories unconditionally is only correct when the second one really is
 * `bin`: for `/home/user/node` it produced `/home`, a rule granting read,
 * list and execute over every home directory on the machine, and nothing
 * refused it. On this host the arithmetic happens to land on a version
 * directory and the harness's protected `src` happens to live under `/home`,
 * so the safety floor happened to catch it — an incidental catch that a
 * harness installed at `/opt` would not have had.
 *
 * So the prefix is returned only when the executable is actually at
 * `<prefix>/bin/<name>`; otherwise the answer is the directory the executable
 * is in, which is the narrowest rule that still lets it run. A derived rule
 * with its own bound, rather than one relying on another rule to notice.
 *
 * READ AND EXECUTE ONLY. The toolchain is never writable, so a command
 * confined to a project still cannot alter the tools the next command runs.
 */
export function interpreterPrefix(execPath: string = process.execPath): string {
  const binDir = dirname(execPath);
  if (binDir === execPath || binDir === "/") return binDir;
  return basename(binDir) === "bin" ? dirname(binDir) : binDir;
}

/**
 * Launch a planned command. THE ONLY PLACE IN THIS SERVER THAT STARTS A
 * PROGRAM IT DID NOT NAME ITSELF.
 *
 * The model's `execute_command` and the project's own quality checks used
 * to each hold their own `spawn`, each preceded by its
 * own copy of "consult the plan, then use what it says". Two copies of one
 * rule is two places for it to rot, and it was not theoretical: with the
 * decision correctly computed in both, making ONE of them spawn the raw
 * command instead of the planned one left every test green. There was no
 * behaviour that could tell the difference, because the difference lived in
 * whichever copy nobody was watching.
 *
 * With one door there is nothing to keep in step. A caller cannot hold a plan
 * and quietly launch something else, because launching is not something a
 * caller does any more — and a source scan can now say, mechanically, that no
 * other module starts a variable-named program at all.
 */
type PlannedSpawnOptions = Readonly<{
  cwd: string;
  env?: NodeJS.ProcessEnv | Readonly<Record<string, string>>;
  stdio?: readonly ("ignore" | "pipe")[];
  signal?: AbortSignal;
}>;

export type CapturedPlannedResult = Readonly<Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr" | "error">>;
type CapturedPlannedOptions = PlannedSpawnOptions & Readonly<{ capture: true; timeout: number }>;

export function spawnPlanned(
  plan: Extract<ConfinedSpawn, { kind: "confined" | "unconfined" }>,
  options: CapturedPlannedOptions,
): Promise<CapturedPlannedResult>;
export function spawnPlanned(
  plan: Extract<ConfinedSpawn, { kind: "confined" | "unconfined" }>,
  options: PlannedSpawnOptions,
): ReturnType<typeof spawn>;
export function spawnPlanned(
  plan: Extract<ConfinedSpawn, { kind: "confined" | "unconfined" }>,
  options: PlannedSpawnOptions | CapturedPlannedOptions,
): ReturnType<typeof spawn> | Promise<CapturedPlannedResult> {
  assertNoInheritedDescriptors(options.stdio);
  options = { ...options, env: plannedEnvironment(plan, options.env) } as typeof options;
  if ("capture" in options && options.capture) {
    // Native capture keeps the same 1 MiB bound as spawnSync, decodes UTF-8
    // across chunks, and reports overflow as failure rather than partial
    // successful output. SIGKILL makes the existing deadline effective for
    // a direct child that ignores TERM. Completion is the native callback,
    // after the child and its captured streams have closed.
    return new Promise((resolve) => {
      const child = execFile(plan.command, [...plan.args], {
        cwd: options.cwd, env: options.env, signal: options.signal,
        encoding: "utf8", timeout: options.timeout, killSignal: "SIGKILL",
      }, guarded("safety.spawn-planned.capture-done", (error: ExecFileException | null, stdout: string, stderr: string) => {
        unregister();
        // Node can report exit 0 after its timeout destroys pipes retained
        // by a descendant of an already-exited parent. Exit success alone
        // is not complete capture: both streams must have reached EOF.
        const incomplete = child.stdout?.readableEnded !== true || child.stderr?.readableEnded !== true;
        const captureError = incomplete && (error === null || typeof error.code === "number")
          ? new ServiceUnavailableError("The process did not return complete captured output.", "incomplete_process_capture")
          : error;
        resolve({
          status: error === null ? 0 : typeof error.code === "number" ? error.code : null,
          stdout, stderr,
          ...(captureError !== null && typeof captureError.code !== "number" ? { error: captureError } : {}),
        });
      }));
      const unregister = registerComponent({
        kind: "command-child", label: "captured command",
        provenance: "server/safety/landlock-runner.ts:spawnPlanned",
        facts: { command: basename(plan.command), pid: child.pid ?? null },
      });
      // Captured reads receive EOF, just as the synchronous Git caller's
      // ignored stdin does; no parent-open descriptor is inherited.
      child.stdin?.end();
    });
  }
  return spawn(plan.command, [...plan.args], options as Parameters<typeof spawn>[2]);
}

/**
 * The same door, for a caller that must wait. `git` is read synchronously all
 * over the project listing, and rewriting every one of those call sites to be
 * asynchronous would be a much larger change than the one being made — so the
 * door has two shapes and one decision behind it, rather than a second
 * decision growing beside it.
 */
export function spawnPlannedSync(
  plan: Extract<ConfinedSpawn, { kind: "confined" | "unconfined" }>,
  options: Readonly<{
    cwd: string;
    env?: NodeJS.ProcessEnv | Readonly<Record<string, string>>;
    stdio?: readonly ("ignore" | "pipe")[];
    /** Required, so the captured output is text for every caller and the
     *  return type is not a union nobody wants to narrow. */
    encoding: "utf8";
    timeout?: number;
  }>,
): SpawnSyncReturns<string> {
  assertNoInheritedDescriptors(options.stdio);
  return spawnSync(plan.command, [...plan.args], { ...options, env: plannedEnvironment(plan, options.env) } as Parameters<typeof spawnSync>[2]) as SpawnSyncReturns<string>;
}

/**
 * THE ENVIRONMENT A PLANNED CHILD STARTS WITH: a confined one's temp-folder
 * variables always name its PRIVATE temp folder (the system temp folder is
 * never granted, and a shared one would hand every confined child every other
 * process's temp files); an unconfined plan's is the caller's, unchanged.
 */
function plannedEnvironment(
  plan: Extract<ConfinedSpawn, { kind: "confined" | "unconfined" }>,
  env: NodeJS.ProcessEnv | Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv | Readonly<Record<string, string>> | undefined {
  return plan.temporaryDirectory === undefined ? env : withPrivateTemporary(env ?? inheritedEnvironment(), plan.temporaryDirectory);
}

/** Create (0700) an MCP server's temp folder — INSIDE its home, so it adds no write root. */
function mcpServerTemporaryDirectory(home: string): string {
  return ensureHarnessOwnedDir(join(home, ".tmp"), "the temp folder this server keeps for an MCP server");
}

/**
 * A CONFINED CHILD MUST NOT BE HANDED A DESCRIPTOR SOMEBODY ELSE OPENED.
 *
 * Landlock authorises at `open()`, not at `read()`. A file the unconfined
 * parent opened and passed down as `stdio: ["ignore", "pipe", "pipe", fd]` is
 * therefore readable in full by the restricted child, whatever the ruleset
 * says — measured, with a file outside every allow-rule.
 *
 * Both real callers pass only `"ignore"` and `"pipe"`, so this is not live
 * today. It is asserted anyway because it is the one property in the whole
 * design a FUTURE caller can break silently: the parameter's type says
 * `("ignore" | "pipe")[]`, the option object is cast on the way to `spawn`,
 * and a number in that array would compile in any caller that has an `any`
 * anywhere upstream. A type that is erased at the boundary is a comment; this
 * is the same rule at a value.
 */
function assertNoInheritedDescriptors(stdio: readonly unknown[] | undefined): void {
  if (stdio === undefined) return;
  // A NON-ARRAY REACHES THIS TOO, and it used to reach `.entries()` and throw a
  // bare `TypeError`. The property still held — nothing ran — but the typed
  // contract this function promises did not, and `stdio: "inherit"` is the
  // ORDINARY Node spelling, so the first caller to use it would have got an
  // internal error message instead of the reason. Failing closed is not the
  // same as failing clearly.
  if (!Array.isArray(stdio)) {
    throw new ValidationError(
      `a confined child's stdio must be given as a list of "ignore" or "pipe", not ${JSON.stringify(stdio)}. `
      + "Landlock checks at open(), so anything this server already opened stays readable inside the sandbox.",
      "invalid_confined_stdio",
    );
  }
  for (const [index, entry] of stdio.entries()) {
    if (entry === "ignore" || entry === "pipe") continue;
    throw new ValidationError(
      `a confined child may not inherit an already-open file descriptor: stdio[${index}] is ${JSON.stringify(entry)}. `
      + "Landlock checks at open(), so a descriptor opened by this server stays readable inside the sandbox.",
      "invalid_confined_stdio",
    );
  }
}

// ── Reading what the guardian did ─────────────────────────────────────────

/**
 * The guardian speaks on stderr, and the child's stderr is what the model
 * reads. Two problems follow, and both are solved here rather than by the
 * caller guessing.
 *
 * FIRST, the guardian prints a confirmation line on every successful run
 * ("default_deny_outside_allow_rules=true: …"). Handed to the model verbatim
 * it reads as an error the command produced, in vocabulary nobody outside
 * this subsystem knows. It is removed from the command's output and the same
 * fact is stated once, in plain words, in the confinement field.
 *
 * SECOND, and much more serious: when the guardian refuses BEFORE it execs —
 * a spec it will not accept, a kernel that will not restrict — the command
 * NEVER RAN, but the child still exits with a code. Read naively that is a
 * command that ran and failed, which is a false statement about the world in
 * the direction that matters. `classifyGuardianResult` is the harness's own
 * discriminator for exactly this and is reused rather than re-derived; the
 * exit code alone is not enough, because a payload may legitimately exit with
 * one of the guardian's own codes.
 */
export type GuardianOutcome =
  | Readonly<{ kind: "payload_ran"; stderr: string }>
  | Readonly<{ kind: "refused_before_exec"; code: number; message: string }>;

export function readGuardianOutcome(exitCode: number | null, stderr: string): GuardianOutcome {
  const classified = classifyGuardianResult(exitCode ?? -1, stderr);
  if (classified.kind === "pre_exec_failure") {
    return { kind: "refused_before_exec", code: classified.exitCode, message: classified.message };
  }
  return { kind: "payload_ran", stderr: stripGuardianNotices(stderr) };
}

/**
 * Drop the guardian's own lines from a captured stderr, keeping the rest
 * byte-for-byte — including a partial final line, which a capture cap can
 * leave behind and which is still the command's own output.
 *
 * MATCHED ON THE GUARDIAN'S FULL DOCUMENTED SHAPE, from the harness's own
 * owner, and not on the bare marker. Removing every line that merely STARTS
 * with the marker deleted a program's own words whenever they happened to
 * begin with it — a silent edit of somebody else's output, which is never the
 * right default. A line has to look like something the guardian wrote before
 * it is treated as something the guardian wrote.
 */
export function stripGuardianNotices(stderr: string): string {
  const notice = guardianNoticeLinePattern();
  const lines = stderr.split("\n");
  if (!lines.some((line) => notice.test(line))) return stderr;
  return lines.filter((line) => !notice.test(line)).join("\n");
}

/**
 * Resolve a bare command name to an absolute path the way the child process
 * would, because the guardian must allow-list the executable BEFORE it runs
 * and cannot ask the kernel to resolve a name for it afterwards.
 *
 * The search list is the CHILD's `PATH`, taken from the same allow-listed
 * environment the child is actually given — not this process's own. The
 * distinction is not pedantic: resolving against the server's `PATH` while
 * spawning with a filtered one lets the two disagree, and then confinement
 * grants execute permission on a binary the child will never find, producing
 * a denial that looks like a sandbox bug and is really a mismatch. One
 * environment, asked twice. An absolute or explicitly relative command is
 * taken as given.
 */
export function resolveExecutable(
  command: string,
  env: Readonly<Record<string, string | undefined>> = serverConfig.subprocessEnv,
): string | null {
  if (command.includes("/")) return existsSync(command) ? command : null;
  const search = env.PATH;
  if (search === undefined || search.length === 0) return null;
  for (const dir of search.split(":")) {
    if (dir.length === 0) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Whether the selected project's folder is present and is a real directory.
 *
 * One question, answered at the one place every command path converges. The
 * answer deliberately does not say WHICH path failed — a wiped scratchpad
 * path is a detail the person was never shown, and naming it reads as the
 * harness leaking its own bookkeeping. What the refusal names is the project
 * they selected and the way out.
 *
 * A broken symbolic link is reported as missing, which is the honest reading:
 * the folder it points at is not there. A link to a real folder is a
 * legitimate project, so this FOLLOWS links (`statSync`) rather than
 * inspecting the link itself — the same question `spawn` would ask of the
 * working directory, answered before the spawn so its answer can be worded.
 */
function projectRootIsUsableDirectory(projectRoot: string): boolean {
  if (projectRoot.length === 0) return false;
  try {
    return statSync(projectRoot).isDirectory();
  } catch {
    return false;
  }
}
