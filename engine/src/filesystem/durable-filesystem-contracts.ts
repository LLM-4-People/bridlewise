export type DurableDirectoryIdentity = Readonly<{
  device: string;
  inode: string;
  mode: string;
  ownerUid: string;
  ownerGid: string;
}>;

/**
 * An opaque, callback-scoped authority. Its lexical path and immutable identity
 * are observations only; neither can be used to manufacture another authority.
 */
export type DurableDirectory = Readonly<{
  identity: DurableDirectoryIdentity;
  lexicalPath: string;
}>;

export type DurableDirectoryRequest = Readonly<{
  absoluteRoot: string;
  create: boolean;
  relativeSegments: readonly string[];
}>;

export type DurableFileRead =
  | Readonly<{ disposition: "missing" }>
  | Readonly<{ disposition: "present"; bytes: Buffer; byteLength: number; sha256: string }>
  | Readonly<{ disposition: "unsafe"; reason: string }>;

export type DurableDirectoryEntry = Readonly<{
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
}>;

export type DurableExclusiveCreate = Readonly<{
  disposition: "created" | "existing";
  byteLength: number;
  sha256: string;
}>;
