import {
  createExclusiveDurableFileInternal,
  enumerateDurableDirectoryInternal,
  readDurableFileInternal,
  withDurableDirectoryAsyncInternal,
  withDurableDirectoryInternal,
} from "./durable-filesystem-internal.ts";
import type {
  DurableDirectory,
  DurableDirectoryEntry,
  DurableDirectoryRequest,
  DurableExclusiveCreate,
  DurableFileRead,
} from "./durable-filesystem-contracts.ts";

export type {
  DurableDirectory,
  DurableDirectoryEntry,
  DurableDirectoryIdentity,
  DurableDirectoryRequest,
  DurableExclusiveCreate,
  DurableFileRead,
} from "./durable-filesystem-contracts.ts";

export function withDurableDirectory<Result>(
  request: DurableDirectoryRequest,
  operation: (directory: DurableDirectory) => Result extends PromiseLike<unknown> ? never : Result,
): Result {
  return withDurableDirectoryInternal(request, operation);
}

export function withDurableDirectoryAsync<Result>(
  request: DurableDirectoryRequest,
  operation: (directory: DurableDirectory) => PromiseLike<Result>,
): Promise<Result> {
  return withDurableDirectoryAsyncInternal(request, operation);
}

export function createExclusiveDurableFile(
  directory: DurableDirectory,
  name: string,
  bytes: Uint8Array,
): DurableExclusiveCreate {
  return createExclusiveDurableFileInternal(directory, name, bytes);
}

export function readDurableFile(directory: DurableDirectory, name: string): DurableFileRead {
  return readDurableFileInternal(directory, name);
}

export function enumerateDurableDirectory(
  directory: DurableDirectory,
): readonly DurableDirectoryEntry[] {
  return enumerateDurableDirectoryInternal(directory);
}
