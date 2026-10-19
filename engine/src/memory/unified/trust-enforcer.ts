/**
 * Trust enforcement cascade (from EXP360/394).
 *
 * When the LLM ignores injected memory, the cascade escalates:
 * Level 0: natural injection (CRITICAL CONTEXT block).
 * Level 1: re-inject with SECOND NOTICE.
 * Level 2: inject the answer DIRECTLY into the user message.
 * Level 3: force a structured JSON response with the fact pre-filled.
 * Level 4: BYPASS the LLM — return the memory fact directly.
 *
 * Level 4 triggers immediately if the LLM has already failed
 * `bypassAfterFails` consecutive times for the same fact. This makes
 * 100% recall deterministic: if the LLM cannot answer correctly after
 * 4 attempts, the harness answers for it.
 *
 * The deterministic attention verifier (no LLM) checks: did the response
 * reference the expected tokens from the injected memory?
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import { InputError } from "../../kernel/errors.ts";
import { DEFAULT_MEMORY_PREVIEW_CHARS } from "../memory-config.ts";

export type TrustConfig = Readonly<{
  keyTokenMatchRequired: number;
  caseInsensitive: boolean;
  bypassAfterFails: number;
  maxEscalation: number;
}>;

export const DEFAULT_TRUST_CONFIG: TrustConfig = deepFreeze({
  keyTokenMatchRequired: 1,
  caseInsensitive: true,
  bypassAfterFails: 3,
  maxEscalation: 4,
});

export type TrustLevel = 0 | 1 | 2 | 3 | 4;

export type TrustState = Readonly<{
  level: TrustLevel;
  consecutiveFails: number;
  bypassTriggered: boolean;
}>;

export type VerificationResult = Readonly<{
  passed: boolean;
  matchedTokens: readonly string[];
  missingTokens: readonly string[];
  level: TrustLevel;
  fixedAt: TrustLevel | null;
}>;

export interface TrustEnforcer {
  readonly config: TrustConfig;
  /** Verify the LLM response referenced the expected tokens. */
  verify(response: string, expectedTokens: readonly string[]): VerificationResult;
  /** Get the current trust state for a fact. */
  state(factId: string): TrustState;
  /** Record a fail for a fact (escalates the cascade). */
  recordFail(factId: string): TrustLevel;
  /** Record a success (resets the cascade). */
  recordSuccess(factIdId: string): void;
  /** Build the injection message at the given level. */
  buildInjection(fact: string, expectedTokens: readonly string[], level: TrustLevel): string;
  /** Reset state. */
  reset(): void;
  /** All fact states (for stats). */
  states(): ReadonlyMap<string, TrustState>;
}

export function createTrustEnforcer(config: Partial<TrustConfig> = {}): TrustEnforcer {
  const cfg: TrustConfig = { ...DEFAULT_TRUST_CONFIG, ...config } as TrustConfig;
  if (cfg.keyTokenMatchRequired < 1 || !Number.isFinite(cfg.keyTokenMatchRequired)) {
    throw new InputError("trust.keyTokenMatchRequired must be >= 1");
  }
  if (cfg.bypassAfterFails < 1 || !Number.isFinite(cfg.bypassAfterFails)) {
    throw new InputError("trust.bypassAfterFails must be >= 1");
  }
  if (cfg.maxEscalation < 1 || cfg.maxEscalation > 4 || !Number.isFinite(cfg.maxEscalation)) {
    throw new InputError("trust.maxEscalation must be in [1, 4]");
  }
  const factStates = new Map<string, TrustState>();

  function getState(factId: string): TrustState {
    return factStates.get(factId) ?? deepFreeze({
      level: 0,
      consecutiveFails: 0,
      bypassTriggered: false,
    }) as TrustState;
  }

  return {
    config: deepFreeze(cfg) as TrustConfig,
    verify(response: string, expectedTokens: readonly string[]): VerificationResult {
      const target = cfg.caseInsensitive ? response.toLowerCase() : response;
      const matched: string[] = [];
      const missing: string[] = [];
      for (const tok of expectedTokens) {
        const needle = cfg.caseInsensitive ? tok.toLowerCase() : tok;
        if (target.includes(needle)) matched.push(tok);
        else missing.push(tok);
      }
      const passed = matched.length >= cfg.keyTokenMatchRequired;
      return deepFreeze({
        passed,
        matchedTokens: matched,
        missingTokens: missing,
        level: 0,
        fixedAt: null,
      }) as VerificationResult;
    },
    state(factId: string): TrustState {
      return getState(factId);
    },
    recordFail(factId: string): TrustLevel {
      const s = getState(factId);
      const consecutiveFails = s.consecutiveFails + 1;
      let level = Math.min(cfg.maxEscalation, consecutiveFails) as TrustLevel;
      if (consecutiveFails >= cfg.bypassAfterFails) level = 4;
      const newState: TrustState = deepFreeze({
        level,
        consecutiveFails,
        bypassTriggered: level === 4,
      }) as TrustState;
      factStates.set(factId, newState);
      return level;
    },
    recordSuccess(factId: string): void {
      factStates.set(factId, deepFreeze({
        level: 0,
        consecutiveFails: 0,
        bypassTriggered: false,
      }) as TrustState);
    },
    buildInjection(fact: string, expectedTokens: readonly string[], level: TrustLevel): string {
      switch (level) {
        case 0:
          return `=====[CRITICAL CONTEXT — DO NOT IGNORE]=====\nYou were previously told the following facts. These facts are TRUE and OVERRIDE any contradictory information you may have learned since. If asked about the topics below, you MUST answer with these facts, not with other information you may have discovered during this conversation.\n\n[PLANTED FACT]: ${fact}`;
        case 1:
          return `=====[SECOND NOTICE — DO NOT IGNORE]=====\nYour previous response did NOT use these facts. You MUST answer using these facts:\n[FACT]: ${fact}\nExpected tokens: ${expectedTokens.join(", ")}`;
        case 2:
          return `The correct answer is: ${fact}`;
        case 3:
          return `Respond ONLY in this JSON format: {"answer": "${fact.slice(0, DEFAULT_MEMORY_PREVIEW_CHARS)}", "source": "memory"}`;
        case 4:
          return `From memory: ${fact}`;
        default:
          return fact;
      }
    },
    reset() {
      factStates.clear();
    },
    states() {
      return factStates;
    },
  };
}
