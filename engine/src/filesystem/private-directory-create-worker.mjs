import { constants, fstatSync, lstatSync, mkdirSync, writeSync } from "node:fs";
import { argv, env, exit, getuid, umask } from "node:process";

const FAILURE_EXIT_CODE = 64;

function reject(code) {
  writeSync(2, `${code}\n`);
  exit(FAILURE_EXIT_CODE);
}

function exactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function identity(stats) {
  return {
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
    ownerUid: stats.uid.toString(10),
    ownerGid: stats.gid.toString(10),
    mode: (stats.mode & 0o7777n).toString(8).padStart(4, "0"),
  };
}

function writeResult(contract, disposition, directoryIdentity) {
  const result = {
    schemaVersion: contract.schemaVersion,
    compositionIdentity: contract.compositionIdentity,
    disposition,
    ...(directoryIdentity === undefined ? {} : { identity: directoryIdentity }),
  };
  writeSync(1, `${JSON.stringify(result)}\n`);
}

function validContract(contract) {
  if (!exactKeys(contract, [
    "compositionIdentity",
    "directoryMode",
    "maximumSegmentBytes",
    "normalization",
    "parentDescriptor",
    "procFileDescriptorRoot",
    "schemaVersion",
    "segmentPatternSource",
  ])) return false;
  return typeof contract.schemaVersion === "string" && contract.schemaVersion.length > 0 &&
    typeof contract.compositionIdentity === "string" && /^[0-9a-f]{64}$/u.test(contract.compositionIdentity) &&
    contract.procFileDescriptorRoot === "/proc/self/fd" &&
    Number.isInteger(contract.parentDescriptor) && contract.parentDescriptor >= 3 &&
    contract.parentDescriptor <= 9 && contract.directoryMode === constants.S_IRWXU &&
    Number.isInteger(contract.maximumSegmentBytes) && contract.maximumSegmentBytes > 0 &&
    contract.maximumSegmentBytes <= 255 && contract.normalization === "NFC" &&
    typeof contract.segmentPatternSource === "string" && contract.segmentPatternSource.length > 0;
}

function validSegment(segment, contract) {
  if (segment.length === 0 || segment === "." || segment === ".." ||
    segment.normalize("NFC") !== segment || Buffer.byteLength(segment, "utf8") > contract.maximumSegmentBytes ||
    /[\0-\x1f\x7f-\u{10ffff}/\\]/u.test(segment) || !/^[\x20-\x7e]+$/u.test(segment)) return false;
  let pattern;
  try {
    pattern = new RegExp(contract.segmentPatternSource, "u");
  } catch {
    return false;
  }
  return pattern.test(segment);
}

function runPrivateDirectoryCreateWorker(contract) {
  if (!import.meta.url.endsWith("/[eval1]") || Object.keys(env).length !== 0 ||
    argv.length !== 3 || argv[1] !== "-" || !validContract(contract)) {
    reject("private_directory_worker_protocol_invalid");
  }
  const segment = argv[2];
  if (segment === undefined || !validSegment(segment, contract)) {
    reject("private_directory_worker_segment_invalid");
  }
  const parent = fstatSync(contract.parentDescriptor, { bigint: true });
  if (!parent.isDirectory() || parent.uid !== BigInt(getuid()) ||
    (parent.mode & 0o7777n) !== BigInt(contract.directoryMode)) {
    reject("private_directory_worker_parent_invalid");
  }
  const path = `${contract.procFileDescriptorRoot}/${contract.parentDescriptor}/${segment}`;
  umask(0);
  try {
    mkdirSync(path, { mode: contract.directoryMode });
  } catch (error) {
    if (error?.code === "EEXIST") {
      writeResult(contract, "existing");
      return;
    }
    reject("private_directory_worker_mkdir_failed");
  }
  const created = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (created === undefined || !created.isDirectory() || created.isSymbolicLink() ||
    created.dev !== parent.dev || created.uid !== parent.uid || created.gid !== parent.gid ||
    (created.mode & 0o7777n) !== BigInt(contract.directoryMode)) {
    reject("private_directory_worker_created_identity_invalid");
  }
  writeResult(contract, "created", identity(created));
}

if (!import.meta.url.endsWith("/[eval1]")) {
  reject("private_directory_worker_standalone_denied");
}
