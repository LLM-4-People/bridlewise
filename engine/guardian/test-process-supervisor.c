/* Linux process lifetime primitive for the TypeScript test runners (the web
 * suite's and the engine suite's: engine/src/process/supervised-run.ts).
 * Node exposes neither child-subreaper ownership nor pidfd signalling/wait4.
 * Keep this boundary outside the watched runtime; tests and policy stay in TS.
 * Linux manuals: PR_SET_CHILD_SUBREAPER(2), pidfd_open(2), wait4(2).
 *
 * Usage: test-process-supervisor [--pass-fd] <timeout ms> <grace ms> <command> [args...]
 * fd 3 carries this supervisor's receipt. With --pass-fd, the caller's fd 4
 * becomes the COMMAND's fd 3 (a command that reports on fd 3, like the engine
 * test worker, keeps its channel) and the supervisor holds no copy of it.
 *
 * THE RUNNER'S DEATH IS ONE STOP. It arrives as the parent-death signal, and
 * the kernel sends that on EVERY reparent: a dying multi-threaded runner (Node
 * always is) hands this process to each of its still-live threads in turn, so
 * one SIGKILL of the runner delivered one to three signals (measured 15 times,
 * PROMO01-SUPERVISOR-PDEATH). It therefore has a signal of its own
 * (RUNNER_DEATH_SIGNAL), never one of the stop signals: its first delivery is
 * the stop, its repeats are the same death and change nothing, while a real
 * second stop (SIGTERM, SIGINT, SIGHUP) during the grace still kills at once.
 */
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <math.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* The parent-death signal (see the header): never a stop signal, so its repeats are told apart. */
#define RUNNER_DEATH_SIGNAL SIGUSR1

static FILE *receipt;
static bool first_reaped = true;
static bool spawned = false, failing = false;
static pid_t command_pid;
static void cleanup_descendants(void);

static void fail(const char *operation) {
    perror(operation);
    if (spawned) fprintf(stderr, "test supervisor: owned command pid %ld\n", (long)command_pid);
    if (spawned && !failing) {
        failing = true;
        /* Release the receipt descriptor before emergency cleanup, including
         * EMFILE after fork. A failure never publishes a success receipt. */
        if (receipt) { fclose(receipt); receipt = NULL; }
        cleanup_descendants();
    }
    exit(1);
}

static double monotonic_ms(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now)) fail("test supervisor clock");
    return now.tv_sec * 1000.0 + now.tv_nsec / 1000000.0;
}

static double bound(const char *text) {
    char *end;
    errno = 0;
    double value = strtod(text, &end);
    if (errno || !*text || *end || !isfinite(value) || value <= 0 || value > INT_MAX) {
        fprintf(stderr, "test supervisor: invalid process bound\n");
        exit(1);
    }
    return value;
}

static int pidfd(pid_t pid) {
    int fd = (int)syscall(SYS_pidfd_open, pid, 0);
    if (fd < 0) fail("test supervisor pidfd_open");
    return fd;
}

static void signal_owned(int fd, int signal) {
    /* A pidfd cannot name a recycled PID. WNOWAIT also proves this is still
     * our child without releasing its identity before signalling it. */
    siginfo_t info = {0};
    if (waitid(P_PIDFD, fd, &info, WEXITED | WNOHANG | WNOWAIT))
        fail("test supervisor child ownership");
    if (syscall(SYS_pidfd_send_signal, fd, signal, NULL, 0) && errno != ESRCH)
        fail("test supervisor pidfd_send_signal");
}

static pid_t reap(pid_t child, int *status, int options) {
    pid_t pid;
    do { pid = waitpid(child, status, options); } while (pid < 0 && errno == EINTR);
    return pid;
}

/* Reaps `child` by `deadline`; false when the deadline passed or a stop
 * arrived (`*interrupted`). The runner's death is a stop only where
 * `runner_death_stops` says so: during a grace it is a repeat of the first. */
static bool wait_until(pid_t child, int *status, double deadline,
                       const sigset_t *signals, bool runner_death_stops, bool *interrupted) {
    for (;;) {
        pid_t pid = reap(child, status, WNOHANG);
        if (pid == child) return true;
        if (pid < 0) fail("test supervisor waitpid");
        if (*interrupted) return false;
        double left = deadline - monotonic_ms();
        if (left <= 0) return false;
        struct timespec remaining = {
            .tv_sec = (time_t)(left / 1000),
            .tv_nsec = (long)(fmod(left, 1000) * 1000000)
        };
        int received = sigtimedwait(signals, NULL, &remaining);
        if (received == SIGTERM || received == SIGINT || received == SIGHUP ||
            (received == RUNNER_DEATH_SIGNAL && runner_death_stops)) *interrupted = true;
        else if (received < 0 && errno != EAGAIN && errno != EINTR)
            fail("test supervisor sigtimedwait");
    }
}

static void record_reaped(pid_t pid, int status, bool killed) {
    if (!receipt) return;
    fprintf(receipt, "%s{\"pid\":%ld,\"status\":%d,\"killed\":%s}",
            first_reaped ? "" : ",", (long)pid, status, killed ? "true" : "false");
    first_reaped = false;
}

static void cleanup_descendants(void) {
    for (;;) {
        int status;
        pid_t pid = reap(-1, &status, WNOHANG);
        if (pid > 0) { record_reaped(pid, status, false); continue; }
        if (pid < 0) {
            if (errno == ECHILD) return;
            fail("test supervisor reap descendants");
        }
        /* This process has no other threads/reapers and has not released
         * these children, so their PIDs cannot be recycled during this read.
         * Kill/reap one generation; newly adopted grandchildren then enter
         * the next iteration, including descendants that changed sessions. */
        char path[128];
        snprintf(path, sizeof(path), "/proc/%ld/task/%ld/children", (long)getpid(), (long)getpid());
        FILE *children = fopen(path, "r");
        if (!children) fail("test supervisor owned children");
        char *generation = NULL;
        size_t capacity = 0;
        if (getdelim(&generation, &capacity, '\n', children) <= 0) fail("test supervisor missing owned child");
        fclose(children);
        /* Snapshot each generation once. Do not reap until all its members
         * have been signalled: their unreaped identities cannot be reused. */
        char *cursor = generation, *end;
        long next;
        while ((next = strtol(cursor, &end, 10)) > 0) {
            if (failing) {
                /* The single reaper has not waited on these direct children.
                 * WNOWAIT proves ownership; keeping zombies unreaped prevents
                 * PID recycling even when no descriptor can be allocated. */
                siginfo_t info = {0};
                if (waitid(P_PID, (id_t)next, &info, WEXITED | WNOHANG | WNOWAIT))
                    fail("test supervisor emergency ownership");
                if (kill((pid_t)next, SIGKILL) && errno != ESRCH)
                    fail("test supervisor emergency signal");
            } else {
                int fd = pidfd((pid_t)next);
                signal_owned(fd, SIGKILL);
                close(fd);
            }
            cursor = end;
        }
        cursor = generation;
        while ((next = strtol(cursor, &end, 10)) > 0) {
            pid = reap((pid_t)next, &status, 0);
            if (pid != next) fail("test supervisor wait for killed child");
            record_reaped(pid, status, true);
            cursor = end;
        }
        free(generation);
    }
}

static int64_t cpu_us(const struct rusage *usage) {
    return (int64_t)usage->ru_utime.tv_sec * 1000000 + usage->ru_utime.tv_usec
         + (int64_t)usage->ru_stime.tv_sec * 1000000 + usage->ru_stime.tv_usec;
}

/* A process's start time (`/proc/<pid>/stat` field 22, clock ticks since
 * boot: the identity the engine's process facts read), or -1. */
static long long start_time_of(pid_t pid)
{
    char path[64];
    snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
    FILE *stat = fopen(path, "re");
    if (stat == NULL) return -1;
    char line[4096];
    size_t length = fread(line, 1, sizeof(line) - 1, stat);
    fclose(stat);
    line[length] = '\0';
    char *field = strrchr(line, ')');
    if (field == NULL) return -1;
    /* After ") " comes field 3 (state); field 22 is the 20th from there. */
    field += 1;
    for (int index = 3; index <= 22; index++) {
        while (*field == ' ') field++;
        if (*field == '\0') return -1;
        if (index == 22) {
            char *end = NULL;
            long long value = strtoll(field, &end, 10);
            return end == field || value < 0 ? -1 : value;
        }
        while (*field != ' ' && *field != '\0') field++;
    }
    return -1;
}

int main(int argc, char **argv) {
    bool pass_fd = argc > 1 && strcmp(argv[1], "--pass-fd") == 0;
    if (pass_fd) { argv++; argc--; }
    if (argc < 4) { fprintf(stderr, "test supervisor: expected [--pass-fd] timeout grace command\n"); return 1; }
    if (pass_fd && fcntl(4, F_GETFD) < 0) { fprintf(stderr, "test supervisor: --pass-fd needs an open fd 4\n"); return 1; }
    double timeout = bound(argv[1]), grace = bound(argv[2]);
    receipt = fdopen(3, "w");
    if (!receipt) fail("test supervisor receipt");
    if (fcntl(3, F_SETFD, FD_CLOEXEC)) fail("test supervisor receipt ownership");
    if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)) fail("test supervisor subreaper");
    sigset_t signals, original;
    sigemptyset(&signals);
    /* A closed terminal (SIGHUP) ends the run exactly like Ctrl-C: every
     * descendant is killed and reaped before the receipt closes. */
    sigaddset(&signals, SIGCHLD); sigaddset(&signals, SIGTERM); sigaddset(&signals, SIGINT); sigaddset(&signals, SIGHUP);
    sigaddset(&signals, RUNNER_DEATH_SIGNAL);
    if (sigprocmask(SIG_BLOCK, &signals, &original)) fail("test supervisor block signals");
    /* The runner that started this supervisor starts it in a process group
     * of its own (so a terminal's Ctrl-C reaches the runner alone, which
     * forwards ONE stop): if that runner dies without stopping it (SIGKILL,
     * the OOM killer), its death arrives here as ONE stop (RUNNER_DEATH_SIGNAL,
     * see the header). A runner that died before the prctl sent nothing: the
     * parent check closes that race, as the command's own check does below. */
    pid_t runner = getppid();
    if (prctl(PR_SET_PDEATHSIG, RUNNER_DEATH_SIGNAL, 0, 0, 0)) fail("test supervisor parent-death stop");
    bool runner_gone = getppid() != runner;
    struct sigaction action = {.sa_handler = SIG_DFL};
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGCHLD, &action, NULL)) fail("test supervisor child disposition");
    double deadline = monotonic_ms() + timeout;
    pid_t supervisor = getpid();
    pid_t child = fork();
    if (child < 0) fail("test supervisor fork");
    if (child == 0) {
        close(3);
        if (pass_fd && (dup2(4, 3) < 0 || close(4))) _exit(126);
        /* If THIS supervisor dies without cleaning up (SIGKILL, the OOM
         * killer), the command dies with it, and the command leads its own
         * process group so whoever started the supervisor can end every
         * descendant that stayed in it (the announced pid below is the
         * group). The parent check closes the race with a supervisor that
         * died before the prctl. */
        if (setpgid(0, 0)) _exit(126);
        if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) || getppid() != supervisor) _exit(126);
        if (sigprocmask(SIG_SETMASK, &original, NULL)) _exit(126);
        execvp(argv[3], &argv[3]);
        perror("test supervisor exec");
        _exit(127);
    }
    spawned = true;
    command_pid = child;
    /* The passed channel is the command's alone: its end-of-file is the
     * command's (and its descendants') closing, never this process's. */
    if (pass_fd && close(4)) fail("test supervisor release passed descriptor");
    /* The ANNOUNCEMENT, one line before anything can go wrong: the command's
     * pid, which is its process group, BOUND TO ITS START TIME (read now,
     * while the command is this process's unreaped child, so its pid cannot
     * name another process yet): a reader that must stop the group later
     * stops only this process's group, never a recycled pid's (KILL-OWNED-ONLY,
     * security K-2). An unreadable start time is said as null, and owns
     * nothing. The receipt proper is the LAST line. */
    long long started = start_time_of(child);
    if (started < 0) fprintf(receipt, "{\"announcedCommandPid\":%ld,\"announcedCommandStartTime\":null}\n", (long)child);
    else fprintf(receipt, "{\"announcedCommandPid\":%ld,\"announcedCommandStartTime\":%lld}\n", (long)child, started);
    if (fflush(receipt)) fail("test supervisor announcement");
    int fd = pidfd(child), status;
    bool interrupted = runner_gone, timed_out = false, killed = false;
    if (!wait_until(child, &status, deadline, &signals, true, &interrupted)) {
        /* The ceiling or a stop (SIGTERM/SIGINT/SIGHUP): the command is told
         * first (SIGTERM: a runner that reports on its way out — the engine
         * worker aborting its test files — gets the grace to do it), then it
         * and every descendant are killed. A second stop kills at once; the
         * runner's death repeated (or after a real stop) is not a second one. */
        timed_out = !interrupted;
        bool again = false;
        signal_owned(fd, SIGTERM);
        if (!wait_until(child, &status, monotonic_ms() + grace, &signals, false, &again)) {
            signal_owned(fd, SIGKILL);
            killed = true;
            if (reap(child, &status, 0) != child) fail("test supervisor command reap");
        }
    }
    close(fd);
    int result = WIFEXITED(status) ? WEXITSTATUS(status) : -WTERMSIG(status);
    fprintf(receipt, "{\"commandPid\":%ld,\"status\":%d,\"timedOut\":%s,\"interrupted\":%s,\"commandKilled\":%s,\"reaped\":[",
            (long)child, result, timed_out ? "true" : "false", interrupted ? "true" : "false", killed ? "true" : "false");
    cleanup_descendants();
    struct rusage waited, own;
    if (getrusage(RUSAGE_CHILDREN, &waited) || getrusage(RUSAGE_SELF, &own)) fail("test supervisor CPU");
    fprintf(receipt, "],\"noOwnedChildren\":true,\"waitedCpuUs\":%" PRId64 ",\"supervisorCpuUsBeforeReceipt\":%" PRId64 "}\n", cpu_us(&waited), cpu_us(&own));
    int close_result = fclose(receipt);
    receipt = NULL;
    if (close_result) fail("test supervisor close receipt");
    return 0;
}
