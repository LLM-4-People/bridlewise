import { deepFreeze } from "../kernel/integrity.ts";
import type {
  DataFlowNode,
  DataFlowResult,
  ModuleInfo,
  RepositoryMap,
  SymbolInfo,
} from "./intelligence-types.ts";
import { tokenizeWithPositions, type Token } from "./js-tokenizer.ts";
import { findSymbolUsage } from "./symbol-search.ts";
import { DEFAULT_DATA_FLOW_MAX_DEPTH } from "./intelligence-config.ts";

/**
 * Lightweight data-flow analysis.
 *
 * Traces how values flow through the codebase at the token level:
 *
 * - **Sources**: where does a value originate? Parameters of functions,
 * return statements, const/let/var assignments, and imported bindings.
 *
 * - **Sinks**: where does a value go? Function arguments, return values
 * consumed by callers, and exported bindings used by importers.
 *
 * - **Flows through**: intermediate transformations — assignments, return
 * statements, and argument passing — that move a value from source to sink.
 *
 * This is a lexical analysis, not a full type-system data flow. It identifies
 * textual occurrences of a symbol name and classifies them by context
 * (parameter, return, assignment, argument). It is discovery evidence only
 * and cannot be used as the sole basis for correctness claims.
 */

export type SourceProvider = Readonly<{
  read(filePath: string): string | null;
}>;

export type DataFlowOccurrence = Readonly<{
  filePath: string;
  line: number;
  column: number;
  role: "source" | "sink" | "transform" | "pass-through";
  context: string;
}>;

export function traceSymbolFlow(
  map: RepositoryMap,
  symbolName: string,
  sourceProvider: SourceProvider,
): DataFlowResult {
  const lowerName = symbolName.toLowerCase();
  const sources: DataFlowNode[] = [];
  const sinks: DataFlowNode[] = [];
  const flows: DataFlowNode[] = [];
  const seenOccurrences = new Set<string>();
  for (const module of map.modules) {
    const content = sourceProvider.read(module.path);
    if (content === null) continue;
    for (const symbol of module.symbols) {
      if (symbol.name.toLowerCase() !== lowerName) continue;
      const occurrences = findOccurrencesInSource(module, symbol.name, content);
      for (const occ of occurrences) {
        const key = `${occ.filePath}:${occ.line}:${occ.column}`;
        if (seenOccurrences.has(key)) continue;
        seenOccurrences.add(key);
        const node: DataFlowNode = {
          symbol,
          filePath: occ.filePath,
          role: occ.role,
        };
        if (occ.role === "source") sources.push(node);
        else if (occ.role === "sink") sinks.push(node);
        else flows.push(node);
      }
    }
  }
  const usage = findSymbolUsage(map, symbolName);
  for (const importer of usage.importers) {
    const importModule = map.modules.find((m) => m.path === importer.filePath);
    if (!importModule) continue;
    for (const symbol of importModule.symbols) {
      if (symbol.name.toLowerCase() !== lowerName) continue;
      const key = `import:${importer.filePath}:${symbolName}`;
      if (seenOccurrences.has(key)) continue;
      seenOccurrences.add(key);
      sinks.push({
        symbol,
        filePath: importer.filePath,
        role: "sink",
      });
    }
  }
  const fallbackSymbol: SymbolInfo = sources[0]?.symbol ?? deepFreeze({
    name: symbolName,
    kind: "function" as const,
    visibility: "local" as const,
    location: { filePath: "", line: 0, column: 0 },
    exported: false,
    async: false,
    generator: false,
    parameterCount: 0,
    modifiers: deepFreeze([]),
  });
  return deepFreeze({
    symbol: fallbackSymbol,
    sources: deepFreeze(sources),
    sinks: deepFreeze(sinks),
    flowsThrough: deepFreeze(flows),
  });
}

export function findOccurrencesInSource(
  module: ModuleInfo,
  symbolName: string,
  content: string,
): readonly DataFlowOccurrence[] {
  const occurrences: DataFlowOccurrence[] = [];
  const tokens = tokenizeWithPositions(content);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "identifier" || token.value !== symbolName) continue;
    const role = classifyOccurrence(tokens, i);
    if (role === null) continue;
    occurrences.push({
      filePath: module.path,
      line: token.line,
      column: token.column,
      role: role.role,
      context: role.context,
    });
  }
  return deepFreeze(occurrences);
}

type OccurrenceClassification = Readonly<{
  role: "source" | "sink" | "transform" | "pass-through";
  context: string;
}>;

function classifyOccurrence(
  tokens: readonly Token[],
  index: number,
): OccurrenceClassification | null {
  const prev = tokens[index - 1];
  const prev2 = tokens[index - 2];
  const next = tokens[index + 1];
  const next2 = tokens[index + 2];
  if (prev?.value === "function" || (prev2?.value === "function" && prev?.value === "*")) {
    return { role: "source", context: "function-declaration" };
  }
  if (prev?.value === "class" || prev?.value === "interface" || prev?.value === "type" ||
    prev?.value === "enum" || prev?.value === "namespace") {
    return { role: "source", context: "type-declaration" };
  }
  if (prev?.value === "const" || prev?.value === "let" || prev?.value === "var") {
    return { role: "source", context: "variable-declaration" };
  }
  if (prev2?.value === "const" || prev2?.value === "let" || prev2?.value === "var") {
    return { role: "source", context: "variable-declaration" };
  }
  if (prev?.value === "return") {
    return { role: "transform", context: "return-statement" };
  }
  if (next?.value === "=" && next2?.value !== "=" && next2?.value !== "!" &&
    next2?.value !== "<" && next2?.value !== ">") {
    return { role: "transform", context: "assignment" };
  }
  if (prev?.value === "(") {
    if (prev2?.value === "function") {
      return { role: "source", context: "parameter" };
    }
    return { role: "sink", context: "argument" };
  }
  if (prev?.value === ",") {
    return { role: "sink", context: "argument" };
  }
  if (prev?.value === "import" || prev2?.value === "import" ||
    (prev?.value === "{" && prev2?.value === "import")) {
    return { role: "source", context: "import" };
  }
  if (prev?.value === "export") {
    return { role: "sink", context: "export" };
  }
  if (next?.value === "(") {
    return { role: "sink", context: "call" };
  }
  if (next?.value === "." || next?.value === "?.") {
    return { role: "pass-through", context: "member-access" };
  }
  return { role: "pass-through", context: "reference" };
}

export function traceValueFlow(
  map: RepositoryMap,
  symbolName: string,
  options: Readonly<{ maxDepth?: number }> = {},
): Readonly<{
  rootSymbol: SymbolInfo | null;
  sourceFile: string | null;
  consumers: readonly Readonly<{ filePath: string; symbolName: string }>[];
  transitiveConsumers: readonly string[];
}> {
  const maxDepth = options.maxDepth ?? DEFAULT_DATA_FLOW_MAX_DEPTH;
  let rootSymbol: SymbolInfo | null = null;
  let sourceFile: string | null = null;
  for (const module of map.modules) {
    for (const symbol of module.symbols) {
      if (symbol.name === symbolName && symbol.exported) {
        rootSymbol = symbol;
        sourceFile = module.path;
        break;
      }
    }
    if (rootSymbol) break;
  }
  if (!rootSymbol || !sourceFile) {
    return deepFreeze({
      rootSymbol: null,
      sourceFile: null,
      consumers: deepFreeze([]),
      transitiveConsumers: deepFreeze([]),
    });
  }
  const visited = new Set<string>([sourceFile]);
  const consumers: Readonly<{ filePath: string; symbolName: string }>[] = [];
  const queue: Readonly<{ file: string; depth: number; symbol: string }>[] = [
    { file: sourceFile, depth: 0, symbol: symbolName },
  ];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    const usage = findSymbolUsage(map, current.symbol);
    for (const importer of usage.importers) {
      if (visited.has(importer.filePath)) continue;
      visited.add(importer.filePath);
      consumers.push(Object.freeze({ filePath: importer.filePath, symbolName: current.symbol }));
      const importModule = map.modules.find((m) => m.path === importer.filePath);
      if (importModule) {
        for (const exp of importModule.exports) {
          if (exp.kind === "declared" && exp.localName) {
            queue.push({ file: importer.filePath, depth: current.depth + 1, symbol: exp.localName });
          }
        }
      }
    }
  }
  return deepFreeze({
    rootSymbol,
    sourceFile,
    consumers: deepFreeze(consumers),
    transitiveConsumers: deepFreeze([...visited].filter((f) => f !== sourceFile).toSorted()),
  });
}

export function findParameterSources(
  map: RepositoryMap,
  functionName: string,
): readonly DataFlowNode[] {
  const lowerName = functionName.toLowerCase();
  const sources: DataFlowNode[] = [];
  for (const module of map.modules) {
    for (const symbol of module.symbols) {
      if (symbol.name.toLowerCase() !== lowerName) continue;
      if (symbol.kind !== "function" && symbol.kind !== "const") continue;
      if (symbol.parameterCount > 0) {
        sources.push({
          symbol,
          filePath: module.path,
          role: "source",
        });
      }
    }
  }
  return deepFreeze(sources);
}

export function findReturnSinks(
  map: RepositoryMap,
  functionName: string,
): readonly DataFlowNode[] {
  const lowerName = functionName.toLowerCase();
  const sinks: DataFlowNode[] = [];
  for (const module of map.modules) {
    for (const symbol of module.symbols) {
      if (symbol.name.toLowerCase() !== lowerName) continue;
      if (symbol.kind === "function" || (symbol.kind === "const" && symbol.async)) {
        sinks.push({
          symbol,
          filePath: module.path,
          role: "sink",
        });
      }
    }
  }
  return deepFreeze(sinks);
}
