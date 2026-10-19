/**
 * Canonical `BigIntStats` identity comparison.
 *
 * ONE source of truth for the device/inode/metadata fingerprint check that
 * was previously duplicated across:
 * - `config.ts`
 * - `preflight.ts`
 */

import type { BigIntStats } from "node:fs";

/**
 * `true` when two `BigIntStats` describe the same filesystem identity
 * (device, inode, mode, owner, link count, size, and nano-second
 * modification/change times all match).
 */
export function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
