export type FilesystemBoundaryCode = "path_cross_device_denied" | "path_mountpoint_denied";
export type RelativePathViolationKind =
  | "absolute"
  | "backslash"
  | "control-character"
  | "dot-segment"
  | "empty"
  | "empty-segment";

const PATH_CONTROL = /[\u0000-\u001f\u007f]/u;

export function decideFilesystemBoundary(
  rootDevice: bigint,
  targetDevice: bigint,
  targetIsMountPoint: boolean,
): FilesystemBoundaryCode | undefined {
  if (targetDevice !== rootDevice) return "path_cross_device_denied";
  if (targetIsMountPoint) return "path_mountpoint_denied";
  return undefined;
}

export function relativePathViolationKinds(path: string): readonly RelativePathViolationKind[] {
  const reasons: RelativePathViolationKind[] = [];
  if (path === "") reasons.push("empty");
  if (path.startsWith("/")) reasons.push("absolute");
  if (path.includes("\\")) reasons.push("backslash");
  if (PATH_CONTROL.test(path)) reasons.push("control-character");
  const segments = path.split("/");
  if (segments.some((segment) => segment === "")) reasons.push("empty-segment");
  if (segments.some((segment) => segment === "." || segment === "..")) reasons.push("dot-segment");
  return Object.freeze(reasons.toSorted());
}
