#ifndef HARNESS_LANDLOCK_GUARDIAN_H
#define HARNESS_LANDLOCK_GUARDIAN_H

/*
 * landlock-guardian.h — constants, struct fallbacks, flag table, ABI mask.
 *
 * This header is self-contained: it pulls in <linux/landlock.h> when the
 * toolchain has it (via __has_include) and provides inline fallback
 * definitions for the constants and structs when the header is missing, so
 * the binary builds on older dev boxes. It never hardcodes syscall numbers
 * when <sys/syscall.h> provides them.
 */

#include <stdint.h>
#include <stddef.h>

/* ---- Landlock UAPI (best-effort include, fallback if absent) ---------- */

#if defined(__has_include)
#  if __has_include(<linux/landlock.h>)
#    include <linux/landlock.h>
#  endif
#endif

#ifndef LANDLOCK_CREATE_RULESET_VERSION
/* Fallback UAPI for toolchains without <linux/landlock.h>. Numeric values
 * are stable, kernel-defined ABI constants (linux/landlock.h). */
#  define LANDLOCK_CREATE_RULESET_VERSION       (1U << 0)
#  define LANDLOCK_RULE_PATH_BENEATH           1

#  define LANDLOCK_ACCESS_FS_EXECUTE          (1ULL << 0)
#  define LANDLOCK_ACCESS_FS_WRITE_FILE        (1ULL << 1)
#  define LANDLOCK_ACCESS_FS_READ_FILE         (1ULL << 2)
#  define LANDLOCK_ACCESS_FS_READ_DIR          (1ULL << 3)
#  define LANDLOCK_ACCESS_FS_REMOVE_DIR        (1ULL << 4)
#  define LANDLOCK_ACCESS_FS_REMOVE_FILE       (1ULL << 5)
#  define LANDLOCK_ACCESS_FS_MAKE_CHAR         (1ULL << 6)
#  define LANDLOCK_ACCESS_FS_MAKE_DIR          (1ULL << 7)
#  define LANDLOCK_ACCESS_FS_MAKE_REG          (1ULL << 8)
#  define LANDLOCK_ACCESS_FS_MAKE_SOCK         (1ULL << 9)
#  define LANDLOCK_ACCESS_FS_MAKE_FIFO         (1ULL << 10)
#  define LANDLOCK_ACCESS_FS_MAKE_BLOCK        (1ULL << 11)
#  define LANDLOCK_ACCESS_FS_MAKE_SYM         (1ULL << 12)
#  define LANDLOCK_ACCESS_FS_REFER             (1ULL << 13)
#  define LANDLOCK_ACCESS_FS_TRUNCATE          (1ULL << 14)
#  define LANDLOCK_ACCESS_FS_IOCTL_DEV         (1ULL << 15)

struct landlock_ruleset_attr {
    uint64_t handled_access_fs;
    uint64_t handled_access_net;
    uint64_t scoped;
};

struct landlock_path_beneath_attr {
    uint64_t allowed_access;
    int32_t  parent_fd;
} __attribute__((packed));
#endif /* LANDLOCK_CREATE_RULESET_VERSION */

/* ---- Syscall numbers (authoritative from <sys/syscall.h>, fallback) --- */

#include <sys/syscall.h>

#ifndef __NR_landlock_create_ruleset
#  define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#  define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#  define __NR_landlock_restrict_self 446
#endif

/* Older UAPI headers (for example Ubuntu 24.04's 6.8 headers) know the
 * Landlock syscalls but predate IOCTL_DEV. The bit is stable kernel ABI;
 * define it locally so the flag table compiles. mask_flags_to_abi() drops
 * it on kernels whose probed ABI is older than 5. */
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#  define LANDLOCK_ACCESS_FS_IOCTL_DEV         (1ULL << 15)
#endif

/* ---- Flag table ------------------------------------------------------- */

/*
 * The 16 canonical LANDLOCK_ACCESS_FS_* short names (ABI 1-5). Short names
 * are the spec-facing strings WITHOUT the LANDLOCK_ACCESS_FS_ prefix.
 *
 * NOTE: RESOLVE_UNIX is intentionally absent. It is a LANDLOCK_SCOPE_* flag,
 * not a LANDLOCK_ACCESS_FS_* flag, and does not belong in handled_access_fs.
 * Any unknown name in the spec is a spec_parse_error (fail-closed).
 *
 * applies_to classifies each flag by the inode types it can govern in an
 * allow_rule's allowed_access:
 *   LANDLOCK_FLAG_ANY      — valid for both file-targeted and dir-targeted
 *                            rules (file-level operations: read/write/exec/
 *                            truncate; these also govern files inside a dir
 *                            subtree, so they are valid for dir rules too).
 *   LANDLOCK_FLAG_DIR_ONLY — valid ONLY for dir-targeted rules (directory
 *                            operations: listing, making/removing entries,
 *                            reparenting, ioctl on devices within the tree).
 *                            A file-targeted rule with a DIR_ONLY flag is
 *                            rejected at validation (exit 4) because the
 *                            kernel would reject it (EINVAL) and because such
 *                            a flag is meaningless for a single file.
 *
 * File-valid flags (ANY): EXECUTE, WRITE_FILE, READ_FILE, TRUNCATE.
 * Dir-only flags (DIR_ONLY): READ_DIR, REMOVE_*, MAKE_*, REFER, IOCTL_DEV.
 *
 * IOCTL_DEV is DIR_ONLY here because device files (S_ISCHR/S_ISBLK) are
 * rejected entirely as allow_rule paths (only regular files and directories
 * are accepted); IOCTL_DEV therefore can never legitimately appear on a
 * file-targeted rule in this binary. On a directory rule it governs ioctl
 * on device files within the subtree.
 */
enum { LANDLOCK_FLAG_DIR_ONLY = 0, LANDLOCK_FLAG_ANY = 1 };

typedef struct {
    const char *name;     /* short name, e.g. "READ_FILE" */
    uint64_t    value;    /* LANDLOCK_ACCESS_FS_* constant */
    int         min_abi;  /* minimum Landlock ABI supporting this flag */
    int         applies_to; /* LANDLOCK_FLAG_ANY or LANDLOCK_FLAG_DIR_ONLY */
} landlock_fs_flag_t;

static const landlock_fs_flag_t LANDLOCK_FS_FLAGS[] = {
    { "EXECUTE",     LANDLOCK_ACCESS_FS_EXECUTE,     1, LANDLOCK_FLAG_ANY },
    { "WRITE_FILE",  LANDLOCK_ACCESS_FS_WRITE_FILE,   1, LANDLOCK_FLAG_ANY },
    { "READ_FILE",   LANDLOCK_ACCESS_FS_READ_FILE,    1, LANDLOCK_FLAG_ANY },
    { "READ_DIR",    LANDLOCK_ACCESS_FS_READ_DIR,     1, LANDLOCK_FLAG_DIR_ONLY },
    { "REMOVE_DIR",  LANDLOCK_ACCESS_FS_REMOVE_DIR,   1, LANDLOCK_FLAG_DIR_ONLY },
    { "REMOVE_FILE", LANDLOCK_ACCESS_FS_REMOVE_FILE,  1, LANDLOCK_FLAG_DIR_ONLY },
    { "MAKE_CHAR",   LANDLOCK_ACCESS_FS_MAKE_CHAR,    1, LANDLOCK_FLAG_DIR_ONLY },
    { "MAKE_DIR",    LANDLOCK_ACCESS_FS_MAKE_DIR,     1, LANDLOCK_FLAG_DIR_ONLY },
    { "MAKE_REG",    LANDLOCK_ACCESS_FS_MAKE_REG,     1, LANDLOCK_FLAG_DIR_ONLY },
    { "MAKE_SOCK",   LANDLOCK_ACCESS_FS_MAKE_SOCK,    1, LANDLOCK_FLAG_DIR_ONLY },
    { "MAKE_FIFO",   LANDLOCK_ACCESS_FS_MAKE_FIFO,    1, LANDLOCK_FLAG_DIR_ONLY },
    { "MAKE_BLOCK",  LANDLOCK_ACCESS_FS_MAKE_BLOCK,   1, LANDLOCK_FLAG_DIR_ONLY },
    { "MAKE_SYM",    LANDLOCK_ACCESS_FS_MAKE_SYM,     1, LANDLOCK_FLAG_DIR_ONLY },
    { "REFER",       LANDLOCK_ACCESS_FS_REFER,        2, LANDLOCK_FLAG_DIR_ONLY },
    { "TRUNCATE",    LANDLOCK_ACCESS_FS_TRUNCATE,     3, LANDLOCK_FLAG_ANY },
    { "IOCTL_DEV",   LANDLOCK_ACCESS_FS_IOCTL_DEV,    5, LANDLOCK_FLAG_DIR_ONLY },
};
static const size_t LANDLOCK_FS_FLAGS_LEN =
    sizeof(LANDLOCK_FS_FLAGS) / sizeof(LANDLOCK_FS_FLAGS[0]);

/* ---- Helpers ---------------------------------------------------------- */

/*
 * Mask a flags bitmask to only the bits valid at the given ABI version.
 * Drops any bit whose min_abi > abi. This is the kernel-docs-recommended
 * pattern: never pass flags the running kernel doesn't know.
 */
static inline uint64_t mask_flags_to_abi(uint64_t flags, int abi)
{
    uint64_t out = 0;
    for (size_t i = 0; i < LANDLOCK_FS_FLAGS_LEN; i++) {
        if (LANDLOCK_FS_FLAGS[i].min_abi > abi) continue;
        if (flags & LANDLOCK_FS_FLAGS[i].value) {
            out |= LANDLOCK_FS_FLAGS[i].value;
        }
    }
    return out;
}

/*
 * Resolve a short flag name to its numeric constant, or 0 with *found=0 if
 * unknown. A name must match exactly one table entry. Returns the constant
 * for an exact match.
 */
static inline uint64_t landlock_flag_by_name(const char *name, int *found)
{
    *found = 0;
    if (!name) return 0;
    for (size_t i = 0; i < LANDLOCK_FS_FLAGS_LEN; i++) {
        const char *a = LANDLOCK_FS_FLAGS[i].name;
        const char *b = name;
        while (*a && *b && *a == *b) { a++; b++; }
        if (*a == 0 && *b == 0) {
            *found = 1;
            return LANDLOCK_FS_FLAGS[i].value;
        }
    }
    return 0;
}

/*
 * Returns 1 if the named flag is valid for a file-targeted allow_rule
 * (applies_to == LANDLOCK_FLAG_ANY), 0 otherwise. The caller must have
 * already confirmed the name is a known flag (via landlock_flag_by_name);
 * unknown names return 0 here and should be reported as spec_parse_error
 * (exit 2) by the caller, not as a file-validity violation.
 */
static inline int landlock_flag_applies_to_file(const char *name)
{
    if (!name) return 0;
    for (size_t i = 0; i < LANDLOCK_FS_FLAGS_LEN; i++) {
        const char *a = LANDLOCK_FS_FLAGS[i].name;
        const char *b = name;
        while (*a && *b && *a == *b) { a++; b++; }
        if (*a == 0 && *b == 0) {
            return LANDLOCK_FS_FLAGS[i].applies_to == LANDLOCK_FLAG_ANY ? 1 : 0;
        }
    }
    return 0;
}

#endif /* HARNESS_LANDLOCK_GUARDIAN_H */
