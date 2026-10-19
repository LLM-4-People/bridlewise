/**
 * Minimal type declaration for the optional `@xenova/transformers` peer
 * dependency. The candidate ships WITHOUT `@xenova/transformers` installed
 * (it's an optional "embedding pack" provided by the host); `embedding-provider.ts`
 * dynamically imports the package and gracefully falls back to `null` when
 * it's not installed. This ambient declaration lets TypeScript compile
 * without the package present.
 *
 * The real package (`@xenova/transformers@2.17.2`) provides its own types;
 * when installed, those types take precedence over this minimal shim
 * (TypeScript resolves the real `.d.ts` first).
 */

declare module "@xenova/transformers" {
  export interface PipelineOutput {
    data: Float32Array | number[];
    dims: readonly number[];
  }
  export type Pipeline = (
    inputs: readonly string[],
    options?: { pooling?: string; normalize?: boolean },
  ) => Promise<PipelineOutput>;
  export function pipeline(
    task: string,
    model: string,
    options?: { dtype?: string },
  ): Promise<Pipeline>;
  export const env: {
    cacheDir: string;
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    backends: {
      onnx: {
        wasm: {
          wasmPaths: string;
          numThreads: number;
          proxy: boolean;
        };
      };
    };
  };
}
