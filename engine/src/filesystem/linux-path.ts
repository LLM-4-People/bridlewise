import { SecurityError } from "../kernel/errors.ts";
import { mountInfoDocument } from "../process/process-facts.ts";
import { handleError } from "../shared/debug/debug-system.ts";

export function hasTraversalSegment(path: string): boolean {
  return path.split(/[\\/]/u).some((component) => component === "..");
}

/** One mount of this process's mount namespace (`/proc/self/mountinfo`). */
export type LinuxMount = Readonly<{ mountPoint: string; fsType: string; superOptions: string }>;

/**
 * THE MOUNT TABLE, parsed once per call: `id parent major:minor root
 * mountpoint options [optional…] - fstype source superoptions`.
 */
function readLinuxMounts(): readonly LinuxMount[] {
  const mountInfo = mountInfoDocument();
  if (mountInfo === undefined) throw new SecurityError("Linux mount information is required", "mount_information_unavailable");
  return mountInfo.split("\n").flatMap((line) => {
    const fields = line.split(" ");
    const mountPath = fields[4];
    const separator = fields.indexOf("-", 6);
    if (mountPath === undefined || separator < 0) return [];
    return [{ mountPoint: decodeMountPath(mountPath), fsType: fields[separator + 1] ?? "", superOptions: fields[separator + 3] ?? "" }];
  });
}

export function readLinuxMountPoints(): ReadonlySet<string> {
  return new Set(readLinuxMounts().map((mount) => mount.mountPoint));
}

/**
 * A WINDOWS DRIVE MOUNTED INTO WSL (DrvFs): the Windows filesystem, whose
 * names compare case-insensitively (`.CODEX` is `.codex`). WSL1 names the
 * type `drvfs`; WSL2 mounts it over 9p with `aname=drvfs`.
 */
function isWindowsDriveMount(mount: LinuxMount): boolean {
  return mount.fsType === "drvfs" || (mount.fsType === "9p" && mount.superOptions.split(/[;,]/u).includes("aname=drvfs"));
}

let windowsDriveMountPointsCache: readonly string[] | undefined;

/**
 * THE WINDOWS DRIVES OF THIS HOST (DrvFs mount points), read once per process:
 * they are mounted when WSL starts, and every consumer (the path locator, the
 * keep-out list, the long-name resolution below) asks this one answer. A
 * mount table that cannot be read yields none — the strict reading for every
 * consumer (names then compare exactly) — and the gap is reported.
 */
export function windowsDriveMountPoints(): readonly string[] {
  if (windowsDriveMountPointsCache === undefined) {
    let mounts: readonly LinuxMount[] = [];
    try { mounts = readLinuxMounts(); } catch (error) {
      handleError(error, { module: "filesystem/linux-path", operation: "windowsDriveMountPoints" });
    }
    windowsDriveMountPointsCache = Object.freeze(mounts.filter(isWindowsDriveMount).map((mount) => mount.mountPoint));
  }
  return windowsDriveMountPointsCache;
}

function decodeMountPath(path: string): string {
  return path.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}
