---
id: GUARD-F5
date: 2026-10-07
by: coordinator
group: engine
status: in-force
implementation: partial
route: KEEP-OUT-HARDLINKS
acted_in: [engine/guardian/landlock-guardian.c, engine/src/filesystem/self-protection/keep-out.ts, engine/test/filesystem/self-protection/keep-out-links.test.ts, engine/test/filesystem/self-protection/keep-out-link-contract.test.ts, engine/test/filesystem/self-protection/apply-self-protection.test.ts]
---
# A link under the keep-out floor is kept out by what it names

One link at a place the floor's wildcard matches
(`~/.local/state/bridlewise-*`) made the guardian refuse EVERY confined spawn
with ELOOP, and an entry that changed while it was located did the same with
ESTALE (LAND-OC-F5, 2026-10-07): a denial of service in the confinement
owner. The coordinator's decision (2026-10-07):

- The guardian resolves a link entry ONCE, when it builds the policy, one
  link at a time (at most 40), and keeps out the link's own place (its
  identity in its folder, like any keep-out file: a grant over that folder
  refuses).
- **Round 6 (§S1, §S1a; the coordinator's decision of 2026-10-08): fail
  closed for the affected spawn.** Every place that decides what the entry
  names is judged against the spawn's grants: the folder of each link on the
  way (whoever can write it can retarget the link), the final target, and a
  dangling link's would-be target's deepest existing folder (whoever can
  write there can create it). When one lies inside a grant, THAT spawn is
  refused (exit 10, `keep_out_exposed`), naming the link, its hop and the
  remedy: move the harness state out of the grant, or remove the link. Other
  spawns are unaffected, so this does not recreate the F5 incident. Exposing
  the harness's own state through a grant is never acceptable. **Round 7:**
  a grant INSIDE a link's existing target refuses that spawn too (exit 10): it
  exposes part of the kept-out state, exactly as a grant inside the floor
  would. The consequence, stated: a floor link to a broad folder (the home,
  `/`) refuses every spawn whose grant lies under it, by name, with the
  remedy. Each log line claims only what is true.
- **One definition, two judges (UR-16).** The TypeScript keep-out list
  resolves a floor link by the same definition (`keepOutLinkPlaces`,
  engine/src/filesystem/self-protection/keep-out.ts). The project door
  refuses a project that holds a link's target, a hop's folder or a dangling
  link's would-be folder, and a project at or under a link's target — the
  same places, both directions, as the guardian: no difference between the
  judges. A contract test drives both on the same worlds
  (keep-out-link-contract.test.ts).
- **Round 6 (§S2): briefly absent is never unprotected.** A keep-out FILE is
  kept by its folder and its name as well as by its inode. An entry absent
  when the guardian opens it, or one that keeps changing while it is located
  (ESTALE after `selfProtection.keepOutRetries` re-locations, from the root
  policy), is kept out by its folder and its name, logged. A deterministic
  race shim and a racer prove it (keep-out-links.test.ts).
- **Mounts.** The walk from a grant goes up only, so a mount BELOW a grant is
  read from the mount table: one whose root is on a kept-out entry's chain (a
  bind alias of a keep-out folder) refuses that spawn (exit 10). On WSL,
  `/mnt/wslg/distro` is `/` (the same device and inode), so a grant over
  `/mnt/wslg` is refused this way.
- **Round 13 (MF-B, MF-C): the judgement never depends on permission bits a
  confined process can change.** Landlock does not mediate `chmod`, `chown`,
  `utimes` or extended attributes, and the guardian installs no seccomp
  filter: a confined process can make a folder it owns unsearchable. So a
  folder THIS user owns that stops a walk (EACCES on the way to an entry, on
  a link's hop, or listing the floor's own folder) is never trusted: that
  spawn is refused (exit 10), and the project door and the compiler refuse
  every grant (`self_protection_keep_out_folder_unsearchable`), named and
  audited, with the remedy (restore the folder's permissions). A folder
  ANOTHER user owns cannot be changed by a confined process, so the places
  met are judged and the entry is kept by its name (round 12's MF-3 rule,
  kept for availability on a multi-user host). A link to a target that
  stores nothing (a FIFO, a device) is judged by the target's folder against
  every grant that can make or remove entries there; `/dev`, granted only to
  read and write files, still passes. Every entry, a registered store's and
  a host store's family and the floor's own folder included, is named and
  judged through its links (MF-C). The contract test reproduces each world:
  a deeper folder closed, the floor folder closed holding a link or a
  dangling link into the project, a FIFO inside a writable project, and a
  host store whose folder is a link chain through the project.
- Fail-closed stays for anything that would WIDEN access. Every other error
  still refuses the spec.
- **Known limits, stated.** Landlock mediates neither `stat` nor `readlink`
  (no `inode_getattr`, no `inode_readlink` hook): a confined process learns
  the existence, size and modification time of a kept-out file, and a link's
  text. A hard link to a kept-out FILE that already exists inside a grant
  reads through (Landlock is path-based; a confined process cannot create
  one, the kernel refuses a cross-hierarchy link); finding it needs a walk of
  the grant, and it is owned by the TASKS row KEEP-OUT-HARDLINKS.
  Because Landlock does not mediate `chmod`, a confined process can also
  change the mode of a file it can reach (for example make a key outside its
  grants world-readable by `chmod 644` on a path it can name but not read):
  an exposure on a multi-user host, owned by the TASKS row
  LANDLOCK-METADATA-CALLS.

The Landlock semantics this relies on (security/landlock/fs.c;
Documentation/userspace-api/landlock.rst, "Landlock rules" and "Layers of file
path access rights"):

- A rule's object is a file hierarchy, keyed by the inode of the folder the
  rule names (`get_inode_object`/`get_inode_id`), not by a path string.
- An open is judged on the opened file's RESOLVED path: `hook_file_open`
  checks `file->f_path`. `is_access_to_paths_allowed` walks that file's own
  ancestors (`dget_parent`, `follow_up`) for a granting rule.
- So a link grants nothing. Following one reaches the target, and the
  target's own place decides. A target that no grant reaches is denied by
  Landlock's default deny, through the link and directly.
- Landlock registers no `inode_readlink` hook, so a link's own text is never
  something Landlock could keep out. Only grants over its folder could expose
  the folder, and those still refuse.

Each case is proved by running the real guardian over a temporary floor
(engine/test/filesystem/self-protection/keep-out-links.test.ts), and once end
to end through the compiled spec under a substitute HOME
(apply-self-protection.test.ts).
