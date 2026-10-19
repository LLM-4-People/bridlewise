/*
 * landlock-guardian.c — Pattern A: restrict-self + exec.
 *
 * Reads a JSON ruleset spec, probes the running kernel's Landlock ABI, masks
 * flags to the effective ABI, validates allow_rules against protected_subtrees,
 * applies PR_SET_NO_NEW_PRIVS, creates a Landlock ruleset, adds path-beneath
 * allow-rules, restricts self, then execvp()s the payload. The payload and all
 * its descendants inherit the restriction irrevocably.
 *
 * CLI:
 *   harness-landlock-guardian apply --spec <spec.json> --exec <payload> [args...]
 *
 * See DESIGN.md for the full contract and error codes.
 */

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <stdarg.h>
#include <stdint.h>
#include <stddef.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <linux/openat2.h>
#include <linux/version.h>

#include "landlock-guardian.h"

/* ---- typed error reporting ------------------------------------------- */

static void fail(int code, const char *fmt, ...)
    __attribute__((noreturn, format(printf, 2, 3)));

static void fail(int code, const char *fmt, ...)
{
    fflush(stdout);
    fputs("landlock-guardian: ", stderr);
    fprintf(stderr, "%d: ", code);
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
    fflush(stderr);
    exit(code);
}

static void warn(int code, const char *fmt, ...)
    __attribute__((format(printf, 2, 3)));

static void warn(int code, const char *fmt, ...)
{
    fflush(stdout);
    fputs("landlock-guardian: ", stderr);
    fprintf(stderr, "%d: ", code);
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
    fflush(stderr);
}

/* ---- minimal JSON parser --------------------------------------------- */
/*
 * One-shot recursive-descent JSON parser. Supports the spec subset: objects,
 * arrays, strings (with \uXXXX + surrogate-pair UTF-8 decode), integers,
 * booleans, null. Rejects floats/exponents (spec uses integers only). On parse
 * error the whole program exits(2) (fail-closed); the tree is not freed since
 * the process always either execvp()s or exit()s.
 */

typedef enum { J_NULL, J_BOOL, J_NUM, J_STR, J_ARR, J_OBJ } jtype;

typedef struct jval {
    jtype   type;
    long    nval;     /* J_NUM (integer) */
    int     bval;     /* J_BOOL */
    char   *sval;     /* J_STR (owned, malloc'd) */
    struct jval *arr;  /* J_ARR (array of jval) */
    size_t  arr_len;
    char  **keys;      /* J_OBJ (owned keys) */
    struct jval *vals; /* J_OBJ (values) */
    size_t  obj_len;
} jval;

typedef struct {
    const char *s;
    size_t len, i;
    char errmsg[160];
} jparser;

static void jp_err(jparser *p, const char *msg)
{
    snprintf(p->errmsg, sizeof(p->errmsg), "json offset %zu: %s", p->i, msg);
}

static void jp_ws(jparser *p)
{
    while (p->i < p->len) {
        char c = p->s[p->i];
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') p->i++;
        else break;
    }
}

/* append one byte to a growable buffer; return 0 on success */
static int buf_push(char **buf, size_t *cap, size_t *n, char c)
{
    if (*n + 1 > *cap) {
        size_t nc = (*cap < 16) ? 16 : (*cap * 2);
        char *nb = realloc(*buf, nc);
        if (!nb) return -1;
        *buf = nb;
        *cap = nc;
    }
    (*buf)[(*n)++] = c;
    return 0;
}

static int jp_string(jparser *p, char **out)
{
    *out = NULL;
    if (p->i >= p->len || p->s[p->i] != '"') { jp_err(p, "expected string"); return -1; }
    p->i++;
    size_t cap = 16, n = 0;
    char *buf = malloc(cap);
    if (!buf) { jp_err(p, "oom"); return -1; }
    while (p->i < p->len) {
        char c = p->s[p->i++];
        if (c == '"') {
            if (buf_push(&buf, &cap, &n, 0) != 0) { free(buf); jp_err(p, "oom"); return -1; }
            *out = buf;
            return 0;
        }
        if (c == '\\') {
            if (p->i >= p->len) { free(buf); jp_err(p, "bad escape"); return -1; }
            char e = p->s[p->i++];
            switch (e) {
              case '"':  c = '"';  break;
              case '\\': c = '\\'; break;
              case '/':  c = '/';  break;
              case 'b':  c = '\b'; break;
              case 'f':  c = '\f'; break;
              case 'n':  c = '\n'; break;
              case 'r':  c = '\r'; break;
              case 't':  c = '\t'; break;
              case 'u': {
                if (p->i + 4 > p->len) { free(buf); jp_err(p, "bad \\u"); return -1; }
                unsigned int cp = 0;
                for (int k = 0; k < 4; k++) {
                    char h = p->s[p->i++];
                    cp <<= 4;
                    if (h >= '0' && h <= '9') cp |= (unsigned)(h - '0');
                    else if (h >= 'a' && h <= 'f') cp |= (unsigned)(h - 'a' + 10);
                    else if (h >= 'A' && h <= 'F') cp |= (unsigned)(h - 'A' + 10);
                    else { free(buf); jp_err(p, "bad \\u hex"); return -1; }
                }
                /* surrogate pair: hi followed by \u lo */
                if (cp >= 0xD800 && cp <= 0xDBFF) {
                    if (p->i + 6 > p->len || p->s[p->i] != '\\' || p->s[p->i+1] != 'u') {
                        free(buf); jp_err(p, "dangling high surrogate"); return -1;
                    }
                    p->i += 2;
                    unsigned int lo = 0;
                    for (int k = 0; k < 4; k++) {
                        char h = p->s[p->i++];
                        lo <<= 4;
                        if (h >= '0' && h <= '9') lo |= (unsigned)(h - '0');
                        else if (h >= 'a' && h <= 'f') lo |= (unsigned)(h - 'a' + 10);
                        else if (h >= 'A' && h <= 'F') lo |= (unsigned)(h - 'A' + 10);
                        else { free(buf); jp_err(p, "bad surrogate \\u hex"); return -1; }
                    }
                    if (lo < 0xDC00 || lo > 0xDFFF) { free(buf); jp_err(p, "bad low surrogate"); return -1; }
                    cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                    free(buf); jp_err(p, "dangling low surrogate"); return -1;
                }
                if (cp <= 0x7F) {
                    if (buf_push(&buf, &cap, &n, (char)cp) != 0) { free(buf); jp_err(p, "oom"); return -1; }
                } else if (cp <= 0x7FF) {
                    if (buf_push(&buf, &cap, &n, (char)(0xC0 | (cp >> 6))) != 0 ||
                        buf_push(&buf, &cap, &n, (char)(0x80 | (cp & 0x3F))) != 0)
                    { free(buf); jp_err(p, "oom"); return -1; }
                } else if (cp <= 0xFFFF) {
                    if (buf_push(&buf, &cap, &n, (char)(0xE0 | (cp >> 12))) != 0 ||
                        buf_push(&buf, &cap, &n, (char)(0x80 | ((cp >> 6) & 0x3F))) != 0 ||
                        buf_push(&buf, &cap, &n, (char)(0x80 | (cp & 0x3F))) != 0)
                    { free(buf); jp_err(p, "oom"); return -1; }
                } else {
                    if (buf_push(&buf, &cap, &n, (char)(0xF0 | (cp >> 18))) != 0 ||
                        buf_push(&buf, &cap, &n, (char)(0x80 | ((cp >> 12) & 0x3F))) != 0 ||
                        buf_push(&buf, &cap, &n, (char)(0x80 | ((cp >> 6) & 0x3F))) != 0 ||
                        buf_push(&buf, &cap, &n, (char)(0x80 | (cp & 0x3F))) != 0)
                    { free(buf); jp_err(p, "oom"); return -1; }
                }
                continue; /* don't fall through to buf_push(c) */
              }
              default: free(buf); jp_err(p, "bad escape char"); return -1;
            }
        } else if ((unsigned char)c < 0x20) {
            free(buf); jp_err(p, "unescaped control char"); return -1;
        }
        if (buf_push(&buf, &cap, &n, c) != 0) { free(buf); jp_err(p, "oom"); return -1; }
    }
    free(buf);
    jp_err(p, "unterminated string");
    return -1;
}

static int jp_value(jparser *p, jval *out);

static int jp_number(jparser *p, jval *out)
{
    size_t start = p->i;
    if (p->i < p->len && p->s[p->i] == '-') p->i++;
    int got = 0;
    while (p->i < p->len) {
        char c = p->s[p->i];
        if (c >= '0' && c <= '9') { p->i++; got = 1; }
        else break;
    }
    if (!got) { jp_err(p, "expected digit"); return -1; }
    if (p->i < p->len && (p->s[p->i] == '.' || p->s[p->i] == 'e' || p->s[p->i] == 'E')) {
        jp_err(p, "non-integer number not supported");
        return -1;
    }
    errno = 0;
    char *end = NULL;
    long v = strtol(p->s + start, &end, 10);
    if (errno != 0 || end != p->s + p->i) { jp_err(p, "bad number"); return -1; }
    out->type = J_NUM;
    out->nval = v;
    return 0;
}

static int jp_array(jparser *p, jval *out)
{
    p->i++; /* [ */
    out->type = J_ARR;
    size_t cap = 4, n = 0;
    jval *arr = malloc(cap * sizeof(jval));
    if (!arr) { jp_err(p, "oom"); return -1; }
    jp_ws(p);
    if (p->i < p->len && p->s[p->i] == ']') { p->i++; out->arr = arr; out->arr_len = 0; return 0; }
    for (;;) {
        jp_ws(p);
        if (n == cap) {
            size_t nc = cap * 2;
            jval *na = realloc(arr, nc * sizeof(jval));
            if (!na) { free(arr); jp_err(p, "oom"); return -1; }
            arr = na; cap = nc;
        }
        memset(&arr[n], 0, sizeof(jval));
        if (jp_value(p, &arr[n]) != 0) return -1;
        n++;
        jp_ws(p);
        if (p->i >= p->len) { jp_err(p, "unterminated array"); return -1; }
        char c = p->s[p->i];
        if (c == ',') { p->i++; continue; }
        if (c == ']') { p->i++; out->arr = arr; out->arr_len = n; return 0; }
        jp_err(p, "expected , or ]");
        return -1;
    }
}

static int jp_object(jparser *p, jval *out)
{
    p->i++; /* { */
    out->type = J_OBJ;
    size_t cap = 4, n = 0;
    char **keys = malloc(cap * sizeof(char *));
    jval *vals = malloc(cap * sizeof(jval));
    if (!keys || !vals) { free(keys); free(vals); jp_err(p, "oom"); return -1; }
    jp_ws(p);
    if (p->i < p->len && p->s[p->i] == '}') {
        p->i++; out->keys = keys; out->vals = vals; out->obj_len = 0; return 0;
    }
    for (;;) {
        jp_ws(p);
        char *k = NULL;
        if (jp_string(p, &k) != 0) return -1;
        jp_ws(p);
        if (p->i >= p->len || p->s[p->i] != ':') { free(k); jp_err(p, "expected :"); return -1; }
        p->i++;
        if (n == cap) {
            size_t nc = cap * 2;
            char **nk = realloc(keys, nc * sizeof(char *));
            if (!nk) { free(k); jp_err(p, "oom"); return -1; }
            keys = nk;
            jval *nv = realloc(vals, nc * sizeof(jval));
            if (!nv) { free(k); jp_err(p, "oom"); return -1; }
            vals = nv;
            cap = nc;
        }
        keys[n] = k;
        memset(&vals[n], 0, sizeof(jval));
        if (jp_value(p, &vals[n]) != 0) return -1;
        n++;
        jp_ws(p);
        if (p->i >= p->len) { jp_err(p, "unterminated object"); return -1; }
        char c = p->s[p->i];
        if (c == ',') { p->i++; continue; }
        if (c == '}') { p->i++; out->keys = keys; out->vals = vals; out->obj_len = n; return 0; }
        jp_err(p, "expected , or }");
        return -1;
    }
}

static int jp_value(jparser *p, jval *out)
{
    memset(out, 0, sizeof(jval));
    jp_ws(p);
    if (p->i >= p->len) { jp_err(p, "unexpected end"); return -1; }
    char c = p->s[p->i];
    if (c == '"') {
        char *s = NULL;
        if (jp_string(p, &s) != 0) return -1;
        out->type = J_STR;
        out->sval = s;
        return 0;
    }
    if (c == '{') return jp_object(p, out);
    if (c == '[') return jp_array(p, out);
    if (c == '-' || (c >= '0' && c <= '9')) return jp_number(p, out);
    if (p->i + 4 <= p->len && memcmp(p->s + p->i, "true", 4) == 0) {
        p->i += 4; out->type = J_BOOL; out->bval = 1; return 0;
    }
    if (p->i + 5 <= p->len && memcmp(p->s + p->i, "false", 5) == 0) {
        p->i += 5; out->type = J_BOOL; out->bval = 0; return 0;
    }
    if (p->i + 4 <= p->len && memcmp(p->s + p->i, "null", 4) == 0) {
        p->i += 4; out->type = J_NULL; return 0;
    }
    jp_err(p, "unexpected character");
    return -1;
}

static int jparse(const char *src, size_t len, jval *out, char *errbuf, size_t errbuflen)
{
    jparser p = { .s = src, .len = len, .i = 0, .errmsg = "" };
    if (jp_value(&p, out) != 0) {
        snprintf(errbuf, errbuflen, "%s", p.errmsg);
        return -1;
    }
    jp_ws(&p);
    if (p.i != len) {
        snprintf(errbuf, errbuflen, "json trailing data at offset %zu", p.i);
        return -1;
    }
    return 0;
}

static const jval *obj_get(const jval *o, const char *key)
{
    if (!o || o->type != J_OBJ) return NULL;
    for (size_t i = 0; i < o->obj_len; i++) {
        if (strcmp(o->keys[i], key) == 0) return &o->vals[i];
    }
    return NULL;
}

/* ---- path identity ---------------------------------------------------- */
/*
 * EVERY PATH IS OPENED EXACTLY ONCE, AND EVERY DECISION IS MADE ON THAT FD.
 *
 * The rules are compared by IDENTITY — (st_dev, st_ino) of the location and
 * of every ancestor — never by spelling. A bind mount is a second spelling
 * that no realpath() removes (WSL2 exposes the distro root at
 * /mnt/wslg/distro, same device, same inodes), and Landlock attaches rules to
 * inodes: a grant through the alias is a grant on the directory itself. The
 * string compare this replaced let an alias of a protected subtree through.
 *
 * Opened with RESOLVE_NO_SYMLINKS: the compiler emits fully resolved paths,
 * so a link anywhere in one means the path was swapped after it was checked.
 * The rule is then added from the SAME descriptor the checks ran on, so no
 * swap between check and use (TOCTOU) can move it.
 */

#define MAX_ANCESTORS 1024

typedef struct { dev_t dev; ino_t ino; } ident;

typedef struct {
    int     fd;         /* O_PATH, opened once */
    int     is_dir;
    ident   chain[MAX_ANCESTORS]; /* [0] = the location itself, then each ancestor to / */
    size_t  chain_len;
} located;

static int same_ident(ident a, ident b) { return a.dev == b.dev && a.ino == b.ino; }

static int open_no_links(const char *path, int extra_flags)
{
    struct open_how how;
    memset(&how, 0, sizeof(how));
    how.flags = (uint64_t)(O_PATH | O_CLOEXEC | extra_flags);
    how.resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS;
    return (int)syscall(__NR_openat2, AT_FDCWD, path, &how, sizeof(how));
}

/* Walk ".." from `dirfd` (consumed), appending each identity to `loc`. */
static int walk_ancestors(int dirfd, located *loc)
{
    int cur = dirfd;
    for (;;) {
        struct stat st;
        if (fstat(cur, &st) != 0) { close(cur); return -1; }
        if (loc->chain_len >= MAX_ANCESTORS) { close(cur); errno = ENAMETOOLONG; return -1; }
        ident id = { st.st_dev, st.st_ino };
        if (loc->chain_len == 0 || !same_ident(loc->chain[loc->chain_len - 1], id)) loc->chain[loc->chain_len++] = id;
        int parent = openat(cur, "..", O_PATH | O_DIRECTORY | O_CLOEXEC);
        if (parent < 0) { close(cur); return -1; }
        struct stat pst;
        if (fstat(parent, &pst) != 0) { close(parent); close(cur); return -1; }
        close(cur);
        if (pst.st_dev == st.st_dev && pst.st_ino == st.st_ino) { close(parent); return 0; } /* reached / */
        cur = parent;
    }
}

/* Open `path` once (no links) and record the identity of it and every ancestor.
 * Returns 0, or -1 with errno set. */
static int locate(const char *path, located *loc)
{
    memset(loc, 0, sizeof(*loc));
    loc->fd = open_no_links(path, 0);
    if (loc->fd < 0) return -1;
    struct stat st;
    if (fstat(loc->fd, &st) != 0) return -1;
    loc->is_dir = S_ISDIR(st.st_mode) ? 1 : 0;
    if (!loc->is_dir && !S_ISREG(st.st_mode)) { errno = EINVAL; return -1; }
    int dirfd;
    if (loc->is_dir) {
        dirfd = dup(loc->fd);
        if (dirfd < 0) return -1;
        return walk_ancestors(dirfd, loc);
    }
    /* A file: its own identity, then its parent directory's chain. The parent
     * is opened by name, so it is confirmed to hold THIS file right now. */
    loc->chain[loc->chain_len++] = (ident){ st.st_dev, st.st_ino };
    const char *slash = strrchr(path, '/');
    char parent_path[4096];
    size_t plen = slash == NULL || slash == path ? 1 : (size_t)(slash - path);
    if (plen >= sizeof(parent_path)) { errno = ENAMETOOLONG; return -1; }
    memcpy(parent_path, slash == NULL || slash == path ? "/" : path, plen);
    parent_path[plen] = '\0';
    dirfd = open_no_links(parent_path, O_DIRECTORY);
    if (dirfd < 0) return -1;
    struct stat child;
    if (fstatat(dirfd, slash == NULL ? path : slash + 1, &child, AT_SYMLINK_NOFOLLOW) != 0
        || child.st_dev != st.st_dev || child.st_ino != st.st_ino) {
        close(dirfd);
        errno = ESTALE;
        return -1;
    }
    return walk_ancestors(dirfd, loc);
}

/* The place of a keep-out entry known by its folder and name only (a link, or
 * an entry that changed while it was located): `self` first (the link's own
 * identity, or UNKNOWN_IDENT), then the folder's chain, opened without links.
 * Returns 0, or -1 with errno set. */
static const ident UNKNOWN_IDENT = { 0, 0 };

static int locate_by_folder(const char *path, ident self, located *loc)
{
    memset(loc, 0, sizeof(*loc));
    loc->fd = -1;
    loc->chain[loc->chain_len++] = self;
    const char *slash = strrchr(path, '/');
    char parent_path[4096];
    size_t plen = slash == NULL || slash == path ? 1 : (size_t)(slash - path);
    if (plen >= sizeof(parent_path)) { errno = ENAMETOOLONG; return -1; }
    memcpy(parent_path, slash == NULL || slash == path ? "/" : path, plen);
    parent_path[plen] = '\0';
    int dirfd = open_no_links(parent_path, O_DIRECTORY);
    if (dirfd < 0) return -1;
    return walk_ancestors(dirfd, loc);
}

/* `a` is `b` or lies under it (b's identity is on a's ancestor chain). */
static int at_or_under(const located *a, const located *b)
{
    for (size_t i = 0; i < a->chain_len; i++) {
        if (same_ident(a->chain[i], b->chain[0])) return 1;
    }
    return 0;
}

/* ---- how a keep-out entry resolves (THE ONE DEFINITION) -------------- */

/* GUARD-F5: a keep-out entry reached through a link is judged by
 * EVERYTHING the confined process could change to make the entry name its own
 * content: the folder holding each link on the way (a hop: whoever can write
 * that folder can retarget the link), the folder holding each folder a `..`
 * leaves (whoever can write it can replace that folder with a link, and the
 * kernel's `..` then follows it: security MF-1), and the final target — or,
 * for a dangling link, the deepest existing folder of its would-be target
 * (whoever can write there can create it). A target that is neither a file nor
 * a folder (a device, a FIFO, a socket) stores nothing, but whoever can make or
 * remove entries in ITS folder can put a file of its own in its place: that
 * folder is judged against every grant holding such access (MF-B; `/dev`,
 * granted only to read and write files, still passes). A folder that cannot be
 * searched ends the walk: when THIS user owns it the spawn is refused, because
 * Landlock does not mediate `chmod` and a confined process could have closed it
 * to hide what lies behind it (MF-B); a folder another user owns is no folder a
 * confined process can change, so the places met are judged and the entry is
 * kept by its name (MF-3).
 * The walk is the kernel's own, one component at a time (`lstat`,
 * `readlink`), at most MAX_LINK_HOPS links. THE SAME DEFINITION in
 * TypeScript: engine/src/filesystem/self-protection/keep-out.ts
 * `keepOutLinkPlaces`; the contract test drives both on the same worlds. */
#define MAX_LINK_HOPS 40

typedef struct {
    size_t  n_hops, cap_hops, n_links;
    char  **hop_link;   /* each link met on the way, or each folder a `..` leaves */
    char  **hop_folder; /* the (link-free) folder holding it */
    char   *target;     /* the final target, or the would-be target's deepest existing folder */
    int     dangling;   /* the target does not exist (target = its deepest existing folder) */
    int     looping;    /* more than MAX_LINK_HOPS links: no target */
    int     unsearchable; /* a folder on the way cannot be searched (EACCES): no target */
    char   *blocked;    /* that folder (the one whose permission bits stopped the walk) */
    int     inert;      /* the target is neither a file nor a folder: it stores nothing */
} link_resolution;

static void free_resolution(link_resolution *r)
{
    for (size_t i = 0; i < r->n_hops; i++) { free(r->hop_link[i]); free(r->hop_folder[i]); }
    free(r->hop_link);
    free(r->hop_folder);
    free(r->target);
    free(r->blocked);
    memset(r, 0, sizeof(*r));
}

/* MF-B: THE KEEP-OUT JUDGEMENT NEVER DEPENDS ON PERMISSION BITS A CONFINED
 * PROCESS CAN CHANGE. `path`'s nearest folder that can be examined is the one
 * whose permissions stopped a walk; when THIS user owns it, a confined process
 * (this user, under Landlock, which does not mediate `chmod`) could have closed
 * it to hide what lies behind it, so THIS spawn is refused (exit 10), named,
 * with its remedy. A folder another user owns returns: the caller keeps the
 * entry by its name. The same rule in TypeScript: keep-out.ts
 * `refuseOwnUnsearchable`. */
static void refuse_own_unsearchable(const char *entry, const char *path)
{
    char folder[4096];
    if (strlen(path) >= sizeof(folder)) fail(4, "keep_out '%s': the path '%s' is too long to examine", entry, path);
    strcpy(folder, path);
    for (;;) {
        struct stat st;
        if (stat(folder, &st) == 0) {
            if (st.st_uid == geteuid()) {
                fail(10, "keep_out '%s' lies behind '%s', a folder this user owns but cannot search: a confined process can change its permission bits, so what lies behind it cannot be judged; restore its permissions (chmod u+rwx '%s')", entry, folder, folder);
            }
            return;
        }
        if (errno != EACCES && errno != EPERM && errno != ENOENT && errno != ENOTDIR) fail(4, "keep_out '%s': '%s' cannot be examined: %s", entry, folder, strerror(errno));
        if (strcmp(folder, "/") == 0) return;
        char *slash = strrchr(folder, '/');
        if (slash == folder) folder[1] = '\0'; else *slash = '\0';
    }
}

/* Record one deciding place: `link` (a link, or a folder a `..` leaves) held by `folder`. */
static int add_hop(link_resolution *r, const char *link, const char *folder)
{
    if (r->n_hops == r->cap_hops) {
        size_t cap = r->cap_hops == 0 ? 8 : r->cap_hops * 2;
        char **links = realloc(r->hop_link, cap * sizeof(char *));
        if (links == NULL) return -1;
        r->hop_link = links;
        char **folders = realloc(r->hop_folder, cap * sizeof(char *));
        if (folders == NULL) return -1;
        r->hop_folder = folders;
        r->cap_hops = cap;
    }
    r->hop_link[r->n_hops] = strdup(link);
    r->hop_folder[r->n_hops] = strdup(folder);
    if (r->hop_link[r->n_hops] == NULL || r->hop_folder[r->n_hops] == NULL) return -1;
    r->n_hops++;
    return 0;
}

/* Resolve absolute `path` one component at a time. Returns 0 (with `r`
 * filled; `r->n_hops` 0 means no link on the way), or -1 with errno set. */
static int resolve_entry(const char *path, link_resolution *r)
{
    memset(r, 0, sizeof(*r));
    char cur[4096] = "";       /* the link-free folder reached so far ("" is /) */
    char rest[8192];
    if (strlen(path) >= sizeof(rest)) { errno = ENAMETOOLONG; return -1; }
    strcpy(rest, path);
    while (rest[0] != '\0') {
        char *p = rest;
        while (*p == '/') p++;
        char *end = strchr(p, '/');
        size_t clen = end == NULL ? strlen(p) : (size_t)(end - p);
        char comp[256];
        if (clen >= sizeof(comp)) { errno = ENAMETOOLONG; return -1; }
        memcpy(comp, p, clen);
        comp[clen] = '\0';
        char after[8192];
        snprintf(after, sizeof(after), "%s", end == NULL ? "" : end);
        strcpy(rest, after);
        if (clen == 0 || strcmp(comp, ".") == 0) continue;
        if (strcmp(comp, "..") == 0) {
            char *slash = strrchr(cur, '/');
            if (slash != NULL) {
                /* The folder this `..` leaves decides where it lands (MF-1): its own folder is a hop's folder. */
                char left[4096];
                strcpy(left, cur);
                *slash = '\0';
                if (add_hop(r, left, cur[0] == '\0' ? "/" : cur) != 0) return -1;
            }
            continue;
        }
        char candidate[4096];
        if ((size_t)snprintf(candidate, sizeof(candidate), "%s/%s", cur, comp) >= sizeof(candidate)) { errno = ENAMETOOLONG; return -1; }
        struct stat lst;
        if (lstat(candidate, &lst) != 0) {
            if (errno == EACCES) {
                r->unsearchable = 1;
                r->blocked = strdup(cur[0] == '\0' ? "/" : cur);
                return r->blocked == NULL ? -1 : 0;
            }
            if (errno != ENOENT && errno != ENOTDIR) return -1;
            r->dangling = 1;
            r->target = strdup(cur[0] == '\0' ? "/" : cur);
            return r->target == NULL ? -1 : 0;
        }
        if (!S_ISLNK(lst.st_mode)) {
            strcpy(cur, candidate);
            r->inert = !S_ISDIR(lst.st_mode) && !S_ISREG(lst.st_mode);
            continue;
        }
        if (r->n_links == MAX_LINK_HOPS) { r->looping = 1; return 0; }
        r->n_links++;
        char text[4096];
        ssize_t n = readlink(candidate, text, sizeof(text) - 1);
        if (n < 0) return -1;
        text[n] = '\0';
        if (add_hop(r, candidate, cur[0] == '\0' ? "/" : cur) != 0) return -1;
        char next[8192];
        if ((size_t)snprintf(next, sizeof(next), "%s%s", text, rest) >= sizeof(next)) { errno = ENAMETOOLONG; return -1; }
        strcpy(rest, next);
        if (text[0] == '/') cur[0] = '\0';
    }
    r->target = strdup(cur[0] == '\0' ? "/" : cur);
    return r->target == NULL ? -1 : 0;
}

/* ---- mounts below a grant -------------------------------------------- */

/* Decode mountinfo's octal escapes (\040 for a space…) in place. */
static void mountinfo_unescape(char *s)
{
    char *w = s;
    for (char *r = s; *r != '\0'; r++) {
        if (r[0] == '\\' && r[1] >= '0' && r[1] <= '7' && r[2] >= '0' && r[2] <= '7' && r[3] >= '0' && r[3] <= '7') {
            *w++ = (char)(((r[1] - '0') << 6) | ((r[2] - '0') << 3) | (r[3] - '0'));
            r += 3;
        } else {
            *w++ = *r;
        }
    }
    *w = '\0';
}

/* ---- the apply subcommand -------------------------------------------- */

static void cmd_apply(const char *spec_path, char **payload_argv)
    __attribute__((noreturn));

static void cmd_apply(const char *spec_path, char **payload_argv)
{
    /* 1. Read spec file. */
    int fd = open(spec_path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) fail(2, "cannot open spec '%s': %s", spec_path, strerror(errno));
    struct stat st;
    if (fstat(fd, &st) != 0) { int e = errno; close(fd); fail(2, "fstat spec '%s': %s", spec_path, strerror(e)); }
    if (!S_ISREG(st.st_mode)) { close(fd); fail(2, "spec '%s' is not a regular file", spec_path); }
    if (st.st_size < 0 || st.st_size > (off_t)(64 * 1024 * 1024)) { close(fd); fail(2, "spec '%s' too large", spec_path); }
    size_t fsize = (size_t)st.st_size;
    char *buf = malloc(fsize + 1);
    if (!buf) { close(fd); fail(2, "oom reading spec"); }
    size_t off = 0;
    while (off < fsize) {
        ssize_t r = read(fd, buf + off, fsize - off);
        if (r < 0) {
            if (errno == EINTR) continue;
            int e = errno; free(buf); close(fd);
            fail(2, "read spec '%s': %s", spec_path, strerror(e));
        }
        if (r == 0) break;
        off += (size_t)r;
    }
    close(fd);
    buf[off] = 0;
    size_t buflen = off;

    /* 2. Parse JSON. */
    jval root;
    char jerr[160];
    if (jparse(buf, buflen, &root, jerr, sizeof(jerr)) != 0) {
        fail(2, "spec parse error in '%s': %s", spec_path, jerr);
    }
    if (root.type != J_OBJ) fail(2, "spec must be a JSON object");

    /* 3. abi_version_hint (optional, default 0). */
    long hint = 0;
    const jval *vhint = obj_get(&root, "abi_version_hint");
    if (vhint) {
        if (vhint->type != J_NUM) fail(2, "abi_version_hint must be a number");
        hint = vhint->nval;
        if (hint < 0) fail(4, "abi_version_hint must be >= 0 (got %ld)", hint);
    }

    /* 3b. default_deny_outside_allow_rules (optional boolean, default false).
     * Advisory/documentation marker. The binary adds NO implicit system
     * allow-rules — the spec's allow_rules is always the complete allow-set,
     * and Landlock is already deny-by-omission (every path NOT in any
     * allow_rule AND NOT governed by a non-handled flag is denied by
     * default). So this flag does not change the binary's behavior; it
     * documents the spec author's intent (typically set by Author B's
     * wrapper when generating a tight spec) and, when true, the binary
     * emits a confirmation line to stderr so operators can verify the mode.
     * See DESIGN.md "Default-deny outside projectRoot". */
    int default_deny = 0;
    const jval *vdd = obj_get(&root, "default_deny_outside_allow_rules");
    if (vdd) {
        if (vdd->type != J_BOOL) fail(2, "default_deny_outside_allow_rules must be a boolean");
        default_deny = vdd->bval;
    }

    /* 3c. temp_dir (optional string) + temp_dir_access (optional array).
     * Syntactic sugar: if temp_dir is present, the binary appends an
     * allow-rule for it using temp_dir_access flags (default: full
     * read+write+create+remove set for a temp directory). Validated like
     * any other allow-rule. See DESIGN.md "temp_dir convenience". */
    char *temp_dir_path = NULL;
    uint64_t temp_dir_access = 0;
    int temp_dir_set = 0;
    const jval *vtd = obj_get(&root, "temp_dir");
    if (vtd) {
        if (vtd->type != J_STR) fail(2, "temp_dir must be a string");
        temp_dir_path = vtd->sval;
        temp_dir_set = 1;
    }
    const jval *vtda = obj_get(&root, "temp_dir_access");
    if (vtda) {
        if (vtda->type != J_ARR) fail(2, "temp_dir_access must be an array");
        if (!temp_dir_set) fail(4, "temp_dir_access specified without temp_dir");
        for (size_t j = 0; j < vtda->arr_len; j++) {
            const jval *e = &vtda->arr[j];
            if (e->type != J_STR) fail(2, "temp_dir_access[%zu] must be a string", j);
            int found = 0;
            uint64_t v = landlock_flag_by_name(e->sval, &found);
            if (!found) fail(2, "unknown flag name '%s' in temp_dir_access[%zu]", e->sval, j);
            temp_dir_access |= v;
        }
    } else if (temp_dir_set) {
        temp_dir_access = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR |
                          LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE |
                          LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_DIR |
                          LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REMOVE_FILE |
                          LANDLOCK_ACCESS_FS_REMOVE_DIR;
    }

    /* 4. handled_access_fs (required array of flag short names). */
    const jval *hfs = obj_get(&root, "handled_access_fs");
    if (!hfs || hfs->type != J_ARR) fail(2, "handled_access_fs must be an array");
    uint64_t handled = 0;
    for (size_t i = 0; i < hfs->arr_len; i++) {
        const jval *e = &hfs->arr[i];
        if (e->type != J_STR) fail(2, "handled_access_fs[%zu] must be a string", i);
        int found = 0;
        uint64_t v = landlock_flag_by_name(e->sval, &found);
        if (!found) fail(2, "unknown flag name '%s' in handled_access_fs[%zu]", e->sval, i);
        handled |= v;
    }

    /* 5. protected_subtrees (required array of absolute paths), each opened
     *    once and located by identity; they MUST exist (the harness's own
     *    code: a missing one means the layout moved, and the sandbox must not
     *    shrink quietly).
     * 5b. keep_out (optional array): the rest of the keep-out list the
     *    compiler found present (credential stores, the key home, harness
     *    databases). Same comparisons, but an entry GONE since the compile is
     *    skipped: there is nothing left to protect, and a store deleted
     *    between the compile and this open must not refuse every command. */
    const jval *pst = obj_get(&root, "protected_subtrees");
    if (!pst || pst->type != J_ARR) fail(2, "protected_subtrees must be an array");
    const jval *kot = obj_get(&root, "keep_out");
    if (kot && kot->type != J_ARR) fail(2, "keep_out must be an array");
    size_t n_keep_listed = kot ? kot->arr_len : 0;
    located *protected_locs = calloc(pst->arr_len + n_keep_listed + 1, sizeof(located));
    const char **protected_names = calloc(pst->arr_len + n_keep_listed + 1, sizeof(char *));
    if (!protected_locs || !protected_names) fail(2, "oom");
    size_t n_protected = 0;
    for (size_t i = 0; i < pst->arr_len; i++) {
        const jval *e = &pst->arr[i];
        if (e->type != J_STR) fail(2, "protected_subtrees[%zu] must be a string", i);
        if (e->sval[0] != '/') fail(4, "protected_subtrees[%zu] must be absolute: '%s'", i, e->sval);
        if (locate(e->sval, &protected_locs[n_protected]) != 0) {
            fail(4, "protected_subtrees[%zu] does not exist or is not a resolved path: '%s': %s", i, e->sval, strerror(errno));
        }
        protected_names[n_protected++] = e->sval;
    }
    /* A KEEP-OUT ENTRY IS KEPT BY EVERYTHING THAT DECIDES WHAT IT NAMES
     * (GUARD-F5; the security re-verification's S1, S1a and S2).
     * - An entry that opens without a link is kept by its identity AND, when
     *   it is a file, by its folder and its name (its resolved spelling): a
     *   store replaced (an atomic rename, an unlink and re-create) between
     *   this open and the payload's is still kept out — a grant over its
     *   folder or at its name refuses.
     * - An entry that is gone (ENOENT), or keeps changing while it is located
     *   (ESTALE after `keep_out_retries` tries), is kept by its folder and its
     *   name: briefly absent is never unprotected.
     * - An entry reached through a link is resolved by THE ONE DEFINITION
     *   (`resolve_entry`): every hop's folder and the target (or a dangling
     *   link's would-be target's deepest folder) are judged against the
     *   grants once they are located (6c). One that lies inside a grant
     *   REFUSES THIS SPAWN (exit 10, keep_out_exposed): the confined process
     *   could make the entry name its own content. Other spawns are unaffected,
     *   and the refusal names the link, the hop and the remedy. The link's own
     *   place is kept like any keep-out entry. */
    const jval *kret = obj_get(&root, "keep_out_retries");
    if (kot && !kret) fail(2, "keep_out_retries is required with keep_out (the root policy's selfProtection.keepOutRetries)");
    if (kret && (kret->type != J_NUM || kret->nval < 0 || kret->nval > 16)) fail(2, "keep_out_retries must be a number from 0 to 16");
    long keep_out_retries = kret ? kret->nval : 0;
    typedef struct { const char *name; link_resolution res; int is_link; } link_entry;
    link_entry *link_entries = calloc(n_keep_listed + 1, sizeof(link_entry));
    const char **kept_names = calloc(n_keep_listed + 1, sizeof(char *));
    if (!link_entries || !kept_names) fail(2, "oom");
    size_t n_link_entries = 0, n_kept_names = 0;
    for (size_t i = 0; i < n_keep_listed; i++) {
        const jval *e = &kot->arr[i];
        if (e->type != J_STR) fail(2, "keep_out[%zu] must be a string", i);
        if (e->sval[0] != '/') fail(4, "keep_out[%zu] must be absolute: '%s'", i, e->sval);
        int rc = locate(e->sval, &protected_locs[n_protected]);
        for (long attempt = 0; rc != 0 && errno == ESTALE && attempt < keep_out_retries; attempt++) {
            rc = locate(e->sval, &protected_locs[n_protected]);
        }
        if (rc == 0) {
            /* A file is kept by its NAME too (its folder and its name, as resolved paths): a grant at that
             * name or over its folder refuses whatever inode the name holds by the time the payload opens it. */
            if (!protected_locs[n_protected].is_dir) kept_names[n_kept_names++] = e->sval;
            protected_names[n_protected++] = e->sval;
            continue;
        }
        if (errno == ENOENT || errno == ESTALE) {
            int changing = errno == ESTALE;
            kept_names[n_kept_names++] = e->sval;
            if (locate_by_folder(e->sval, UNKNOWN_IDENT, &protected_locs[n_protected]) == 0) {
                protected_names[n_protected++] = e->sval;
                warn(0, "keep_out[%zu] '%s' %s: kept out by its folder and its name", i, e->sval, changing ? "kept changing while it was located" : "is absent");
            } else {
                warn(0, "keep_out[%zu] '%s' %s and so is its folder: kept out by its name", i, e->sval, changing ? "kept changing while it was located" : "is absent");
            }
            continue;
        }
        if (errno == EINVAL || errno == EACCES) {
            /* Not a file or a folder (a FIFO, a socket, a device: it stores nothing a grant could reach), or under a
             * folder that cannot be searched: kept out by its name (and its folder when that can be located), said,
             * and never a refusal of every spawn (MF-3) — unless that folder is THIS user's, whose permission bits a
             * confined process can change: then THIS spawn is refused (MF-B). */
            int unsearchable = errno == EACCES;
            if (unsearchable) refuse_own_unsearchable(e->sval, e->sval);
            kept_names[n_kept_names++] = e->sval;
            if (locate_by_folder(e->sval, UNKNOWN_IDENT, &protected_locs[n_protected]) == 0) protected_names[n_protected++] = e->sval;
            warn(0, "keep_out[%zu] '%s' %s: kept out by its name", i, e->sval, unsearchable ? "lies under a folder this user cannot search" : "is not a file or a folder (it stores nothing a grant could reach)");
            continue;
        }
        if (errno != ELOOP) fail(4, "keep_out[%zu] is not a resolved path: '%s': %s", i, e->sval, strerror(errno));
        struct stat lst;
        int is_link = lstat(e->sval, &lst) == 0 && S_ISLNK(lst.st_mode);
        kept_names[n_kept_names++] = e->sval;
        if (is_link && locate_by_folder(e->sval, (ident){ lst.st_dev, lst.st_ino }, &protected_locs[n_protected]) == 0) {
            protected_names[n_protected++] = e->sval;
        }
        link_entry *le = &link_entries[n_link_entries];
        if (resolve_entry(e->sval, &le->res) != 0) fail(4, "keep_out[%zu] '%s' cannot be resolved one link at a time: %s", i, e->sval, strerror(errno));
        le->name = e->sval;
        le->is_link = is_link;
        n_link_entries++;
    }
    /* 6. allow_rules (required array). Each path is opened ONCE (no links),
     *    must be a regular file or a directory, and may neither sit under nor
     *    contain a protected subtree — by identity. For file-targeted rules,
     *    access may contain only file-level flags. The rule is later added
     *    from this same descriptor. */
    const jval *ar = obj_get(&root, "allow_rules");
    if (!ar || ar->type != J_ARR) fail(2, "allow_rules must be an array");
    size_t nrules = ar->arr_len;
    size_t nrules_alloc = nrules + (temp_dir_set ? 1 : 0);
    located *rule_locs = calloc(nrules_alloc ? nrules_alloc : 1, sizeof(located));
    uint64_t *rule_access = malloc((nrules_alloc ? nrules_alloc : 1) * sizeof(uint64_t));
    const char **rule_paths = malloc((nrules_alloc ? nrules_alloc : 1) * sizeof(char *));
    if (!rule_locs || !rule_access || !rule_paths) fail(2, "oom");
    for (size_t i = 0; i < nrules; i++) {
        const jval *r = &ar->arr[i];
        if (r->type != J_OBJ) fail(2, "allow_rules[%zu] must be an object", i);
        const jval *rp = obj_get(r, "path");
        if (!rp || rp->type != J_STR) fail(2, "allow_rules[%zu].path must be a string", i);
        if (rp->sval[0] != '/') fail(4, "allow_rules[%zu].path must be absolute: '%s'", i, rp->sval);
        if (locate(rp->sval, &rule_locs[i]) != 0) {
            if (errno == EINVAL) fail(4, "allow_rules[%zu].path is not a regular file or directory: '%s'", i, rp->sval);
            fail(4, "allow_rules[%zu].path does not exist or is not a resolved path: '%s': %s", i, rp->sval, strerror(errno));
        }
        for (size_t k = 0; k < n_protected; k++) {
            if (at_or_under(&rule_locs[i], &protected_locs[k])) {
                fail(4, "allow_rules[%zu].path '%s' is under protected_subtree '%s'", i, rp->sval, protected_names[k]);
            }
            if (at_or_under(&protected_locs[k], &rule_locs[i])) {
                fail(4, "allow_rules[%zu].path '%s' contains protected_subtree '%s'", i, rp->sval, protected_names[k]);
            }
        }
        rule_paths[i] = rp->sval; /* owned by jval tree; not freed here */
        int is_file = !rule_locs[i].is_dir;
        const jval *ra = obj_get(r, "access");
        if (!ra || ra->type != J_ARR) fail(2, "allow_rules[%zu].access must be an array", i);
        uint64_t acc = 0;
        for (size_t j = 0; j < ra->arr_len; j++) {
            const jval *ae = &ra->arr[j];
            if (ae->type != J_STR) fail(2, "allow_rules[%zu].access[%zu] must be a string", i, j);
            int found = 0;
            uint64_t v = landlock_flag_by_name(ae->sval, &found);
            if (!found) fail(2, "unknown flag name '%s' in allow_rules[%zu].access[%zu]", ae->sval, i, j);
            if (is_file && !landlock_flag_applies_to_file(ae->sval)) {
                fail(4, "allow_rules[%zu].path is a file but access contains directory-only flag '%s'", i, ae->sval);
            }
            acc |= v;
        }
        rule_access[i] = acc;
    }

    /* 6b. Expand temp_dir convenience into an allow-rule (AFTER explicit
     *     allow_rules so explicit rules take precedence in error messages).
     *     Validates: absolute, exists (no links), is a directory, neither under
     *     nor containing any protected_subtree, not the same location as any
     *     allow_rules path — all by identity. */
    if (temp_dir_set) {
        if (temp_dir_path[0] != '/') fail(4, "temp_dir must be absolute: '%s'", temp_dir_path);
        located *td = &rule_locs[nrules];
        if (locate(temp_dir_path, td) != 0) {
            fail(4, "temp_dir does not exist or is not a resolved path: '%s': %s", temp_dir_path, strerror(errno));
        }
        if (!td->is_dir) fail(4, "temp_dir is not a directory: '%s'", temp_dir_path);
        for (size_t k = 0; k < n_protected; k++) {
            if (at_or_under(td, &protected_locs[k])) {
                fail(4, "temp_dir '%s' is under protected_subtree '%s'", temp_dir_path, protected_names[k]);
            }
            if (at_or_under(&protected_locs[k], td)) {
                fail(4, "temp_dir '%s' contains protected_subtree '%s'", temp_dir_path, protected_names[k]);
            }
        }
        for (size_t i = 0; i < nrules; i++) {
            if (same_ident(rule_locs[i].chain[0], td->chain[0])) fail(4, "temp_dir duplicates allow_rules[%zu].path", i);
        }
        rule_paths[nrules] = temp_dir_path; /* owned by jval tree; not freed */
        rule_access[nrules] = temp_dir_access;
        nrules++;
    }

    /* 6c. The keep-out entries reached through a link, now that every grant
     *     is located (see 5b): a hop's folder, the target or a dangling
     *     link's would-be target inside a grant — or a grant inside the
     *     target — refuses THIS spawn (exit 10). The project door judges by
     *     the same places, both directions (keep-out.ts `keepOutLinkPlaces`). */
    for (size_t t = 0; t < n_link_entries; t++) {
        link_entry *le = &link_entries[t];
        const char *remedy = "move the harness state out of the grant, or remove the link";
        for (size_t h = 0; h < le->res.n_hops; h++) {
            located hop;
            if (locate(le->res.hop_folder[h], &hop) != 0) fail(4, "keep_out '%s': the folder '%s' of its link '%s' cannot be located: %s", le->name, le->res.hop_folder[h], le->res.hop_link[h], strerror(errno));
            for (size_t r = 0; r < nrules; r++) {
                if (at_or_under(&hop, &rule_locs[r])) {
                    fail(10, "keep_out '%s' is reached through '%s' (a link, or a folder a '..' leaves), whose folder '%s' lies inside allow_rules '%s': the confined process could retarget it; %s", le->name, le->res.hop_link[h], le->res.hop_folder[h], rule_paths[r], remedy);
                }
            }
            close(hop.fd);
        }
        if (le->res.looping) {
            warn(0, "keep_out '%s' is a looping link (more than %d links): it names nothing; its links' folders lie outside every grant", le->name, MAX_LINK_HOPS);
            continue;
        }
        if (le->res.unsearchable) {
            refuse_own_unsearchable(le->name, le->res.blocked);
            warn(0, "keep_out '%s' resolves through '%s', a folder another user owns that this user cannot search: the places met on the way lie outside every grant; kept out by its name", le->name, le->res.blocked);
            continue;
        }
        if (le->res.inert) {
            /* Whoever can make or remove entries in the inert target's folder can put its own file in its place (MF-B). */
            char folder[4096];
            snprintf(folder, sizeof(folder), "%s", le->res.target);
            char *slash = strrchr(folder, '/');
            if (slash == folder) folder[1] = '\0'; else if (slash != NULL) *slash = '\0';
            located home;
            if (locate(folder, &home) != 0) fail(4, "keep_out '%s': the folder '%s' of its target cannot be located: %s", le->name, folder, strerror(errno));
            const uint64_t entry_changing = LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
                LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM |
                LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_REFER;
            for (size_t r = 0; r < nrules; r++) {
                if ((rule_access[r] & entry_changing) != 0 && at_or_under(&home, &rule_locs[r])) {
                    fail(10, "keep_out '%s' resolves to '%s', which stores nothing, but its folder '%s' lies inside allow_rules '%s', which can make or remove entries there: the confined process could put its own file in its place; %s", le->name, le->res.target, folder, rule_paths[r], remedy);
                }
            }
            close(home.fd);
            warn(0, "keep_out '%s' resolves to '%s', which is not a file or a folder (it stores nothing): its links' folders lie outside every grant, and no grant can make or remove entries in its folder; kept out by its name", le->name, le->res.target);
            continue;
        }
        located target;
        if (locate(le->res.target, &target) != 0) fail(4, "keep_out '%s': its %s '%s' cannot be located: %s", le->name, le->res.dangling ? "would-be target's folder" : "target", le->res.target, strerror(errno));
        for (size_t r = 0; r < nrules; r++) {
            if (at_or_under(&target, &rule_locs[r])) {
                if (le->res.dangling) fail(10, "keep_out '%s' is a dangling link whose would-be target lies in '%s', inside allow_rules '%s': the confined process could create what it names; %s", le->name, le->res.target, rule_paths[r], remedy);
                fail(10, "keep_out '%s' %s '%s', inside allow_rules '%s': its content would be the confined process's; %s", le->name, le->is_link ? "is a link to" : "is reached through a link at", le->res.target, rule_paths[r], remedy);
            }
            /* A grant INSIDE the target exposes part of the kept-out state, exactly as a grant inside the floor would (UR-16). */
            if (!le->res.dangling && at_or_under(&rule_locs[r], &target)) {
                fail(10, "keep_out '%s' %s '%s', and allow_rules '%s' lies inside it: part of its content would be the confined process's; %s", le->name, le->is_link ? "is a link to" : "is reached through a link at", le->res.target, rule_paths[r], remedy);
            }
        }
        close(target.fd);
        if (le->res.dangling) {
            warn(0, "keep_out '%s' is a dangling link: its would-be target's folder '%s' lies outside every grant; kept out by its name and its place", le->name, le->res.target);
        } else {
            warn(0, "keep_out '%s' %s '%s': its links' folders and its target lie outside every grant, and no grant lies inside the target; kept out by its name, its place and its target", le->name, le->is_link ? "is a link to" : "is reached through a link at", le->res.target);
        }
    }
    for (size_t t = 0; t < n_link_entries; t++) free_resolution(&link_entries[t].res);

    /* 6d. A MOUNT BELOW A GRANT that shows a kept-out place (a bind alias of a
     *     keep-out folder, WSL's /mnt/wslg/distro which is /): the walk from a
     *     grant goes up only, so a mount below it is looked for here, in this
     *     process's own mount table. Its root's identity on a keep-out
     *     entry's chain refuses THIS spawn (exit 10). */
    FILE *mounts = fopen("/proc/self/mountinfo", "re");
    if (mounts == NULL) fail(4, "cannot read /proc/self/mountinfo: %s", strerror(errno));
    char *line = NULL;
    size_t line_cap = 0;
    while (getline(&line, &line_cap, mounts) > 0) {
        char *save = NULL;
        char *field = strtok_r(line, " ", &save);
        for (int f = 0; f < 4 && field != NULL; f++) field = strtok_r(NULL, " ", &save);
        if (field == NULL) continue;
        mountinfo_unescape(field);
        for (size_t r = 0; r < nrules; r++) {
            size_t rlen = strlen(rule_paths[r]);
            int below = rlen == 1 ? field[1] != '\0' : strncmp(field, rule_paths[r], rlen) == 0 && field[rlen] == '/';
            if (!below) continue;
            struct stat mst;
            if (stat(field, &mst) != 0) continue; /* a mount point this process cannot reach exposes nothing to it */
            ident root_ident = { mst.st_dev, mst.st_ino };
            for (size_t k = 0; k < n_protected; k++) {
                for (size_t c = 0; c < protected_locs[k].chain_len; c++) {
                    if (same_ident(protected_locs[k].chain[c], root_ident)) {
                        fail(10, "allow_rules '%s' holds the mount '%s', which shows '%s' (kept out) from inside the grant; unmount it or grant a folder that holds no such mount", rule_paths[r], field, protected_names[k]);
                    }
                }
            }
        }
    }
    free(line);
    fclose(mounts);
    for (size_t n = 0; n < n_kept_names; n++) {
        size_t len = strlen(kept_names[n]);
        for (size_t r = 0; r < nrules; r++) {
            size_t rlen = strlen(rule_paths[r]);
            if ((strncmp(rule_paths[r], kept_names[n], len) == 0 && (rule_paths[r][len] == '\0' || rule_paths[r][len] == '/'))
                || (strncmp(kept_names[n], rule_paths[r], rlen) == 0 && (kept_names[n][rlen] == '/' || rlen == 1))) {
                fail(4, "allow_rules path '%s' reaches keep_out '%s', which is kept out by name", rule_paths[r], kept_names[n]);
            }
        }
    }
    free(link_entries);
    free(kept_names);
    for (size_t k = 0; k < n_protected; k++) if (protected_locs[k].fd >= 0) close(protected_locs[k].fd);

    /* 7. Probe ABI. */
    errno = 0;
    long probed = syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (probed < 0) {
        fail(3, "landlock unavailable: ABI probe returned -1 (errno=%d: %s)", errno, strerror(errno));
    }
    if (probed < 1) fail(3, "landlock unavailable: probed ABI %ld < 1", probed);
    int effective_abi = (int)(hint > 0 ? (hint < probed ? hint : probed) : probed);

    /* 8. Mask handled + each rule access to effective ABI. */
    uint64_t masked_handled = mask_flags_to_abi(handled, effective_abi);
    if (masked_handled == 0) {
        fail(4, "no handled flags after ABI masking (effective_abi=%d)", effective_abi);
    }
    for (size_t i = 0; i < nrules; i++) {
        uint64_t masked = mask_flags_to_abi(rule_access[i], effective_abi);
        if ((masked & ~masked_handled) != 0) {
            if (temp_dir_set && i == nrules - 1) {
                fail(4, "temp_dir_access is not a subset of handled_access_fs after ABI masking");
            }
            fail(4, "allow_rules[%zu].access is not a subset of handled_access_fs after ABI masking", i);
        }
        rule_access[i] = masked;
    }

    /* 9. PR_SET_NO_NEW_PRIVS (unprivileged self-restriction prerequisite). */
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
        fail(5, "prctl(PR_SET_NO_NEW_PRIVS) failed: %s", strerror(errno));
    }

    /* 10. Create ruleset. */
    struct landlock_ruleset_attr attr;
    memset(&attr, 0, sizeof(attr));
    attr.handled_access_fs = masked_handled;
    attr.handled_access_net = 0;
#if LINUX_VERSION_CODE >= KERNEL_VERSION(6, 12, 0)
    attr.scoped = 0;
#endif
    int ruleset_fd = (int)syscall(__NR_landlock_create_ruleset, &attr, sizeof(attr), 0);
    if (ruleset_fd < 0) {
        fail(6, "landlock_create_ruleset failed (errno=%d: %s)", errno, strerror(errno));
    }

    /* 11. Add path-beneath rules FROM THE DESCRIPTORS THE CHECKS RAN ON
     * (step 6): an O_PATH descriptor is a valid parent_fd for both a file and
     * a directory rule, and no rename or link swap since can move it. */
    for (size_t i = 0; i < nrules; i++) {
        struct landlock_path_beneath_attr pb;
        memset(&pb, 0, sizeof(pb));
        pb.allowed_access = rule_access[i];
        pb.parent_fd = rule_locs[i].fd;
        long rr = syscall(__NR_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &pb, 0);
        if (rr != 0) {
            int e = errno; close(ruleset_fd);
            fail(7, "landlock_add_rule failed for '%s' (errno=%d: %s)", rule_paths[i], e, strerror(e));
        }
        close(rule_locs[i].fd);
    }

    /* 12. Restrict self. Irrevocable; inherited across fork/exec/clone. */
    if (syscall(__NR_landlock_restrict_self, ruleset_fd, 0) != 0) {
        int e = errno; close(ruleset_fd);
        fail(8, "landlock_restrict_self failed (errno=%d: %s)", e, strerror(e));
    }
    close(ruleset_fd);

    /* 13. No "already confined" env sentinel is set: nothing may decide it is
     * sandboxed from an env value a process can forge (the CLI re-exec that
     * read it is gone). Whether a process is confined is measured, never told. */

    /* If default_deny_outside_allow_rules was set, emit a confirmation line
     * to stderr so operators/wrappers can verify the mode. This does NOT
     * change behavior — Landlock is already deny-by-omission and the binary
     * adds no implicit rules. */
    if (default_deny) {
        warn(0, "default_deny_outside_allow_rules=true: paths not in allow_rules are denied by omission (Landlock default-deny)");
    }

    /* 14. execvp (so $PATH resolution works for "node"). Does not return. */
    execvp(payload_argv[0], payload_argv);
    fail(9, "execvp('%s') failed (errno=%d: %s)", payload_argv[0], errno, strerror(errno));
}

/* ---- main + usage ---------------------------------------------------- */

static void usage(void) __attribute__((noreturn));
static void usage(void)
{
    fflush(stdout);
    fputs("landlock-guardian: 64: usage: harness-landlock-guardian apply --spec <spec.json> --exec <payload> [payload-args...]\n", stderr);
    exit(64);
}

int main(int argc, char **argv)
{
    if (argc < 2) usage();
    if (strcmp(argv[1], "apply") != 0) usage();

    const char *spec_path = NULL;
    char **payload_argv = NULL;
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--spec") == 0) {
            if (i + 1 >= argc) fail(64, "--spec requires a path argument");
            if (payload_argv) fail(64, "--spec must appear before --exec");
            spec_path = argv[++i];
        } else if (strcmp(argv[i], "--exec") == 0) {
            if (i + 1 >= argc) fail(64, "--exec requires a payload argument");
            payload_argv = &argv[++i]; /* NULL-terminated by argv[argc] */
            break;
        } else {
            fail(64, "unexpected argument '%s'", argv[i]);
        }
    }
    if (!spec_path) fail(64, "--spec is required");
    if (!payload_argv) fail(64, "--exec is required");

    cmd_apply(spec_path, payload_argv);
    /* not reached */
    return 0;
}
