#define _DARWIN_C_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <limits.h>
#include <mach/mach_time.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/proc.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

/* Finite storage is itself a guard: exhaustion is loss, never silent
 * truncation. */
#define OWNED_MAX 256
#define RECEIPT_MAX 256
#define OWNED_CHILD_CAP 4096
/* Every descendant inherits this variable; a process that scrubs it and leaves
 * the session before discovery is outside what this guard can reconcile. */
#define MARKER_NAME "HARNESS_DELTA_WINDOW_OWNER"
#define SWEEP_RUNNING_NS 1000000000ULL
#define SWEEP_STOPPING_NS 100000000ULL
typedef struct {
  pid_t pid, parent, pgid;
  uid_t uid;
  uint64_t sec, usec;
  bool gone;
} Identity;
typedef struct {
  dev_t dev;
  ino_t ino;
  struct timespec birth;
} Receipt;
static Identity owned[OWNED_MAX];
static Receipt receipts[RECEIPT_MAX];
static Receipt control_identity;
static bool control_pinned;
static size_t owned_count, receipt_count;
static unsigned execs, sequence;
static int queue_fd = -1, receipt_fd = -1;
static pid_t root_pid = -1;
static bool launched, resumed, stopping, failed, clock_only, output_lost;
static bool kill_sent, cleanup_verified;
static bool loss_reported, unaccounted_seen, late_listing;
static unsigned unaccounted;
static pid_t root_group = -1;
static Identity root_birth;
static uint64_t next_full_sweep_ns;
static char marker[sizeof MARKER_NAME + 33];
static uint64_t deadline_ns, stop_ns;
static double term_ms = -1, kill_ms = -1, disappearance_ms = -1;
static struct stat receipt_stat;
static mach_timebase_info_data_t timebase;
static volatile sig_atomic_t interrupted;

static uint64_t now_ns(void) {
  __uint128_t value = (__uint128_t)mach_continuous_time() * timebase.numer;
  return (uint64_t)(value / timebase.denom);
}
static double latency(void) { return (double)(now_ns() - stop_ns) / 1000000.0; }
static void flush_output(void) {
  if (fflush(stdout) || ferror(stdout))
    output_lost = true;
}
static void phase(const char *name) {
  printf("{\"kind\":\"phase\",\"phase\":\"%s\",\"seq\":%u}\n", name,
         ++sequence);
  flush_output();
}
static int inspect(pid_t pid, Identity *value, uint32_t *status) {
  struct proc_bsdinfo info;
  errno = 0;
  int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info);
  if (size == 0 && errno == ESRCH)
    return 0;
  if (size != sizeof info)
    return -1;
  *value = (Identity){.pid = pid,
                      .parent = (pid_t)info.pbi_ppid,
                      .pgid = (pid_t)info.pbi_pgid,
                      .uid = info.pbi_uid,
                      .sec = info.pbi_start_tvsec,
                      .usec = info.pbi_start_tvusec};
  *status = info.pbi_status;
  return 1;
}
static bool same_identity(const Identity *a, const Identity *b) {
  /* Reparenting and group changes do not change a process's birth identity. */
  return a->pid == b->pid && a->uid == b->uid && a->sec == b->sec &&
         a->usec == b->usec;
}
static int still_owned(Identity *value) {
  Identity current;
  uint32_t status;
  int result = inspect(value->pid, &current, &status);
  if (result == 0) {
    value->gone = true;
    return 0;
  }
  if (result < 0)
    return -1;
  if (value->sec == current.sec && value->usec == current.usec &&
      value->uid != current.uid)
    return -1;
  if (!same_identity(value, &current)) {
    value->gone = true;
    return 0;
  }
  return 1;
}
static int subscribe(uintptr_t ident, int16_t filter, uint16_t flags,
                     uint32_t notes, intptr_t data) {
  struct kevent event;
  EV_SET(&event, ident, filter, flags, notes, data, NULL);
  return kevent(queue_fd, &event, 1, NULL, 0, NULL);
}
static int track_owned(Identity value) {
  for (size_t i = 0; i < owned_count; i++) {
    if (same_identity(&owned[i], &value))
      return 0;
  }
  if (owned_count == OWNED_MAX || value.uid != getuid() || value.pid <= 1)
    return -1;
  if (subscribe((uintptr_t)value.pid, EVFILT_PROC, EV_ADD | EV_CLEAR,
                NOTE_FORK | NOTE_EXEC | NOTE_EXIT, 0))
    return -1;
  owned[owned_count++] = value;
  return 1;
}
/* 1 when the process has called exec, 0 when it has not, -1 when unreadable. */
static int exec_flag(pid_t pid) {
  struct proc_bsdinfo info;
  errno = 0;
  int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info);
  if (size == 0 && errno == ESRCH)
    return -1;
  if (size != sizeof info)
    return -1;
  return (info.pbi_flags & PROC_FLAG_EXEC) ? 1 : 0;
}
/* A spawned descendant ran its image before it could be watched, so the
 * exec is charged when it is first seen; later execs arrive as notifications.
 * A child that vanished before the flag was read is charged conservatively. */
static int add_owned(Identity value, bool charge_exec) {
  int added = track_owned(value);
  if (added <= 0)
    return added;
  if (charge_exec && exec_flag(value.pid) != 0)
    execs++;
  printf("{\"kind\":\"identity\",\"identity\":{\"pid\":%d,\"parent\":%d,"
         "\"pgid\":%d,\"uid\":%u,\"start_sec\":%llu,\"start_usec\":%llu},"
         "\"seq\":%u}\n",
         value.pid, value.parent, value.pgid, value.uid,
         (unsigned long long)value.sec, (unsigned long long)value.usec,
         ++sequence);
  flush_output();
  return 1;
}
static unsigned live_count(void) {
  unsigned count = 0;
  for (size_t i = 0; i < owned_count; i++)
    if (!owned[i].gone)
      count++;
  return count;
}
static void count_record(void) {
  unsigned live = live_count();
  printf(
      "{\"kind\":\"count\",\"execs\":%u,\"live\":%u,\"receipts\":%zu,"
      "\"exec_overshoot\":%u,\"live_overshoot\":%u,\"receipt_overshoot\":%zu,"
      "\"lower_bound\":true,\"seq\":%u}\n",
      execs, live, receipt_count, execs > 15 ? execs - 15 : 0,
      live > 16 ? live - 16 : 0, receipt_count > 16 ? receipt_count - 16 : 0,
      ++sequence);
  flush_output();
}
static int signal_owned(int signal_number) {
  int failure = 0, sent = 0;
  /* Descendants first; every dispatch is checked against its recorded birth. */
  for (size_t remaining = owned_count; remaining > 0; remaining--) {
    Identity *value = &owned[remaining - 1];
    if (value->gone)
      continue;
    int state = still_owned(value);
    if (state < 0) {
      failure = -1;
      continue;
    }
    if (state == 1) {
      if (kill(value->pid, signal_number) == 0)
        sent++;
      else if (errno != ESRCH)
        failure = -1;
    }
  }
  return failure ? failure : sent;
}
static void dispatch(int signal_number) {
  int sent = signal_owned(signal_number);
  if (signal_number == SIGKILL)
    kill_sent = true;
  if (sent < 0) {
    failed = true;
    return;
  }
  if (sent == 0)
    return;
  double measured = latency();
  if (signal_number == SIGTERM)
    term_ms = measured;
  else {
    kill_ms = measured;
    kill_sent = true;
  }
  if (measured > (signal_number == SIGTERM ? 250 : 2250))
    failed = true;
  printf("{\"kind\":\"dispatch\",\"signal\":\"%s\",\"latency_ms\":%.6f,\"seq\":"
         "%u}\n",
         signal_number == SIGTERM ? "TERM" : "KILL", measured, ++sequence);
  flush_output();
}
static void stop_guard_at(const char *reason, bool immediate, uint64_t origin) {
  if (reason && !loss_reported) {
    loss_reported = true;
    failed = true;
    printf("{\"kind\":\"loss\",\"code\":\"%s\",\"seq\":%u}\n", reason,
           ++sequence);
    flush_output();
  }
  if (!stopping) {
    stopping = true;
    stop_ns = origin;
    if (immediate)
      dispatch(SIGKILL);
    else
      dispatch(SIGTERM);
  } else if (immediate && !kill_sent)
    dispatch(SIGKILL);
}
static void stop_guard(const char *reason, bool immediate) {
  stop_guard_at(reason, immediate, now_ns());
}
static bool overrun(void) {
  if (execs > 15 || live_count() > 16 || receipt_count > 16) {
    uint64_t observed = now_ns();
    count_record();
    stop_guard_at("overrun", true, observed);
    return true;
  }
  return false;
}
static int reconcile_tree(void) {
  /* NOTE_TRACK is unavailable on Darwin. Parentage listing cannot see a
     descendant that was reparented first; the group, session and marker sweep
     takes those in and fails the case. */
  for (size_t i = 0; i < owned_count; i++) {
    Identity *parent = &owned[i];
    if (parent->gone)
      continue;
    int state = still_owned(parent);
    if (state < 0)
      return -1;
    if (!state)
      continue;
    pid_t children[OWNED_CHILD_CAP];
    errno = 0;
    int bytes = proc_listpids(PROC_PPID_ONLY, (uint32_t)parent->pid, children,
                              sizeof children);
    if ((bytes == 0 && errno) || bytes < 0 || bytes >= (int)sizeof children ||
        bytes % sizeof(pid_t))
      return -1;
    for (int c = 0; c < bytes / (int)sizeof(pid_t); c++) {
      Identity child;
      uint32_t status;
      int read = inspect(children[c], &child, &status);
      if (read == 0) {
        /* A child that ended before it could be watched is charged one exec;
           its own descendants are reconciled by the sweep. */
        bool known = false;
        for (size_t k = 0; k < owned_count; k++)
          known |= owned[k].pid == children[c];
        if (!known) {
          execs++;
          if (overrun())
            return 0;
        }
        continue;
      }
      if (read < 0 || child.uid != parent->uid)
        return -1;
      if (child.parent != parent->pid)
        continue;
      int added = add_owned(child, true);
      if (added < 0)
        return -1;
      if (added && stopping) {
        if (signal_owned(kill_sent ? SIGKILL : SIGTERM) < 0)
          return -1;
      }
      if (overrun())
        return 0;
    }
  }
  return 0;
}
static int reconcile_receipts(void) {
  struct stat current;
  if (fstat(receipt_fd, &current) || current.st_dev != receipt_stat.st_dev ||
      current.st_ino != receipt_stat.st_ino ||
      current.st_uid != receipt_stat.st_uid || current.st_nlink == 0)
    return -1;
  int copied = dup(receipt_fd);
  if (copied < 0)
    return -1;
  DIR *directory = fdopendir(copied);
  if (!directory) {
    close(copied);
    return -1;
  }
  rewinddir(directory);
  int failure = 0;
  bool control_seen = false;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (!entry) {
      if (errno)
        failure = -1;
      break;
    }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, ".."))
      continue;
    struct stat file;
    if (fstatat(receipt_fd, entry->d_name, &file, AT_SYMLINK_NOFOLLOW) ||
        !S_ISREG(file.st_mode) || file.st_uid != getuid()) {
      failure = -1;
      break;
    }
    if (control_pinned &&
        !strcmp(entry->d_name, "ordinary-window-control.json")) {
      if (file.st_dev != control_identity.dev ||
          file.st_ino != control_identity.ino ||
          file.st_birthtimespec.tv_sec != control_identity.birth.tv_sec ||
          file.st_birthtimespec.tv_nsec != control_identity.birth.tv_nsec ||
          file.st_nlink != 1 || (file.st_mode & 0777) != 0600 ||
          file.st_size > 4096) {
        failure = -1;
        break;
      }
      control_seen = true;
      continue;
    }
    bool seen = false;
    for (size_t i = 0; i < receipt_count; i++) {
      Receipt *r = &receipts[i];
      if (r->dev == file.st_dev && r->ino == file.st_ino &&
          r->birth.tv_sec == file.st_birthtimespec.tv_sec &&
          r->birth.tv_nsec == file.st_birthtimespec.tv_nsec)
        seen = true;
    }
    if (seen)
      continue;
    if (receipt_count == RECEIPT_MAX) {
      failure = -1;
      break;
    }
    receipts[receipt_count++] =
        (Receipt){file.st_dev, file.st_ino, file.st_birthtimespec};
    if (overrun())
      break;
  }
  if (closedir(directory))
    failure = -1;
  if (control_pinned && !control_seen)
    failure = -1;
  return failure;
}
/* 1 when the process environment carries this guard's marker, 0 when it does
 * not, -1 when it cannot be read (platform binaries hide their environment). */
static int has_marker(pid_t pid) {
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = 0;
  if (sysctl(mib, 3, NULL, &size, NULL, 0) || size < sizeof(int) ||
      size > 1048576)
    return -1;
  char *buffer = malloc(size);
  if (!buffer)
    return -1;
  if (sysctl(mib, 3, buffer, &size, NULL, 0) || size < sizeof(int)) {
    free(buffer);
    return -1;
  }
  int argument_count;
  memcpy(&argument_count, buffer, sizeof argument_count);
  char *cursor = buffer + sizeof argument_count, *end = buffer + size;
  int found = 0;
  while (cursor < end && *cursor)
    cursor++;
  while (cursor < end && !*cursor)
    cursor++;
  for (int i = 0; i < argument_count && cursor < end; i++) {
    while (cursor < end && *cursor)
      cursor++;
    cursor++;
  }
  while (cursor < end && *cursor) {
    if (!strcmp(cursor, marker))
      found = 1;
    while (cursor < end && *cursor)
      cursor++;
    cursor++;
  }
  free(buffer);
  return found;
}
/* A candidate whose live ancestry reaches an owned process is an ordinary
 * descendant that parentage reconciliation has not listed yet. A broken chain
 * (reparented to launchd, or a dead parent) is an escape. */
static bool descends_from_owned(pid_t pid) {
  for (int hops = 0; hops < 32; hops++) {
    Identity current;
    uint32_t status;
    if (inspect(pid, &current, &status) != 1)
      return false;
    pid_t parent = current.parent;
    if (parent <= 1)
      return false;
    for (size_t i = 0; i < owned_count; i++)
      if (owned[i].pid == parent && !owned[i].gone &&
          still_owned(&owned[i]) == 1)
        return true;
    pid = parent;
  }
  return false;
}
/* 1 when a live process outside the discovered tree was taken in, 0 when the
 * candidate is known, gone, unrelated or merely not listed yet, -1 when it
 * cannot be classified. */
static int consider_unowned(pid_t pid, bool member) {
  if (pid <= 1 || pid == getpid())
    return 0;
  Identity current;
  uint32_t status;
  int read = inspect(pid, &current, &status);
  if (read == 0)
    return 0;
  if (read < 0)
    return -1;
  for (size_t i = 0; i < owned_count; i++)
    if (same_identity(&owned[i], &current))
      return 0;
  /* An exited process that is not yet reaped can neither run nor fork. */
  if (status == 5)
    return 0;
  if (!member) {
    if (current.sec < root_birth.sec ||
        (current.sec == root_birth.sec && current.usec < root_birth.usec) ||
        current.uid != getuid() || has_marker(pid) != 1)
      return 0;
  }
  if (current.uid != getuid())
    return -1;
  bool listed_late = descends_from_owned(pid);
  int added = add_owned(current, true);
  if (added < 0)
    return -1;
  if (listed_late) {
    late_listing |= added > 0;
    return 0;
  }
  unaccounted++;
  unaccounted_seen = true;
  return 1;
}
static int collect_candidates(int type, uint32_t argument, pid_t *pids,
                              int *count) {
  errno = 0;
  int bytes =
      proc_listpids(type, argument, pids, OWNED_CHILD_CAP * sizeof(pid_t));
  if (bytes == 0 && errno == ESRCH) {
    *count = 0;
    return 0;
  }
  if (bytes < 0 || (bytes == 0 && errno) ||
      bytes >= (int)(OWNED_CHILD_CAP * sizeof(pid_t)) ||
      bytes % sizeof(pid_t))
    return -1;
  *count = bytes / (int)sizeof(pid_t);
  return 0;
}
/* Looks for live processes this guard never discovered through parentage: the
 * process group and session of the root always, and the user's recently
 * started processes carrying the owned marker on the deep pass. Anything found
 * is killed and fails the case; it can never be reported as cleaned up. */
static int sweep_unowned(bool full) {
  if (!launched || root_group <= 1)
    return 0;
  uint64_t now = now_ns();
  bool deep = full || now >= next_full_sweep_ns;
  if (deep)
    next_full_sweep_ns =
        now + (stopping ? SWEEP_STOPPING_NS : SWEEP_RUNNING_NS);
  static pid_t pids[OWNED_CHILD_CAP];
  int count, found = 0;
  if (collect_candidates(PROC_PGRP_ONLY, (uint32_t)root_group, pids, &count))
    return -1;
  for (int i = 0; i < count; i++) {
    int result = consider_unowned(pids[i], true);
    if (result < 0)
      return -1;
    found += result;
  }
  if (deep) {
    if (collect_candidates(PROC_UID_ONLY, getuid(), pids, &count))
      return -1;
    for (int i = 0; i < count; i++) {
      int result = consider_unowned(pids[i], getsid(pids[i]) == root_group);
      if (result < 0)
        return -1;
      found += result;
    }
  }
  if (found) {
    stop_guard("unaccounted", true);
    if (signal_owned(SIGKILL) < 0)
      return -1;
  } else if (late_listing && stopping) {
    if (signal_owned(kill_sent ? SIGKILL : SIGTERM) < 0)
      return -1;
  }
  late_listing = false;
  return found;
}
static void reap_root(void) {
  if (root_pid <= 0)
    return;
  int status;
  pid_t result = waitpid(root_pid, &status, WNOHANG);
  if (result == root_pid)
    root_pid = -1;
  else if (result < 0 && errno != EINTR)
    stop_guard("guard_loss", true);
}
static bool verify_gone(void) {
  bool gone = true;
  reap_root();
  if (root_pid > 0)
    gone = false;
  for (size_t i = 0; i < owned_count; i++) {
    if (owned[i].gone)
      continue;
    int state = still_owned(&owned[i]);
    if (state < 0) {
      failed = true;
      gone = false;
    } else if (state)
      gone = false;
  }
  if (gone && launched && !clock_only) {
    int swept = sweep_unowned(true);
    if (swept < 0) {
      failed = true;
      gone = false;
    } else if (swept > 0)
      gone = false;
  }
  return gone;
}
static void number_or_null(double value) {
  if (value < 0)
    printf("null");
  else
    printf("%.6f", value);
}
static void finish(void) {
  bool verified = cleanup_verified && !unaccounted_seen;
  bool bad = failed || unaccounted_seen;
  printf("{\"kind\":\"final\",\"execs\":%u,\"live\":%u,\"receipts\":%zu,"
         "\"lower_bound\":true,\"unaccounted\":%u,\"failed\":%s,"
         "\"stop_batch\":%s,\"cleanup_verified\":%s,\"term_ms\":",
         execs, live_count(), receipt_count, unaccounted,
         bad ? "true" : "false", bad ? "true" : "false",
         verified ? "true" : "false");
  number_or_null(term_ms);
  printf(",\"kill_ms\":");
  number_or_null(kill_ms);
  printf(",\"disappearance_ms\":");
  number_or_null(disappearance_ms);
  printf(",\"seq\":%u}\n", ++sequence);
  flush_output();
}
static void mark_interrupt(int signal_number) {
  (void)signal_number;
  interrupted = 1;
}
static char **owned_environment(void) {
  size_t count = 0;
  while (environ[count])
    count++;
  char **environment = calloc(count + 2, sizeof *environment);
  if (!environment)
    return NULL;
  size_t used = 0, prefix = sizeof MARKER_NAME;
  for (size_t i = 0; i < count; i++)
    if (strncmp(environ[i], MARKER_NAME "=", prefix))
      environment[used++] = environ[i];
  environment[used++] = marker;
  environment[used] = NULL;
  return environment;
}
static int launch(char **argv, bool inherited_stdio) {
  posix_spawnattr_t attributes;
  posix_spawn_file_actions_t actions;
  int error = posix_spawnattr_init(&attributes);
  if (error)
    return -1;
  error = posix_spawn_file_actions_init(&actions);
  if (error) {
    posix_spawnattr_destroy(&attributes);
    return -1;
  }
  /* A session of its own makes the root's group and session a sweepable
     boundary; the group id then equals the root's pid. */
  short flags = POSIX_SPAWN_START_SUSPENDED | POSIX_SPAWN_SETSID |
                POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK |
                POSIX_SPAWN_CLOEXEC_DEFAULT;
  sigset_t empty, defaults;
  sigemptyset(&empty);
  sigfillset(&defaults);
  error = posix_spawnattr_setflags(&attributes, flags);
  if (!error)
    error = posix_spawnattr_setsigmask(&attributes, &empty);
  if (!error)
    error = posix_spawnattr_setsigdefault(&attributes, &defaults);
  for (int fd = 0; !error && fd < 3; fd++) {
    error = inherited_stdio
                ? posix_spawn_file_actions_adddup2(&actions, fd + 3, fd)
                : posix_spawn_file_actions_addopen(&actions, fd, "/dev/null",
                                                   O_RDWR, 0);
  }
  char **environment = error ? NULL : owned_environment();
  if (!error && !environment)
    error = ENOMEM;
  if (!error)
    error = posix_spawn(&root_pid, argv[0], &actions, &attributes, argv,
                        environment);
  free(environment);
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attributes);
  if (error)
    return -1;
  launched = true;
  root_group = root_pid;
  Identity root;
  uint32_t status;
  if (inspect(root_pid, &root, &status) != 1 || root.parent != getpid() ||
      root.pgid != root_pid || getsid(root_pid) != root_pid ||
      add_owned(root, false) < 0) {
    /* The unreaped direct child cannot have its PID reused. */
    kill(root_pid, SIGKILL);
    return -1;
  }
  root_birth = root;
  execs++;
  count_record();
  if (!overrun())
    phase("root-suspended");
  return 0;
}
static int numbers(char *text, uint64_t *values, size_t count) {
  for (size_t i = 0; i < count; i++) {
    if (*text < '0' || *text > '9')
      return -1;
    char *end;
    errno = 0;
    values[i] = strtoull(text, &end, 10);
    if (errno || (i + 1 == count ? *end != 0 : *end != ' '))
      return -1;
    text = end + (i + 1 < count);
  }
  return 0;
}
static int process_reply(char *text) {
  uint64_t values[2];
  if (numbers(text, values, 2) || values[0] < 1 || values[0] > 1000000 ||
      values[1] < 2 || values[1] > INT_MAX)
    return -1;
  Identity value;
  uint32_t status;
  int found = inspect((pid_t)values[1], &value, &status);
  if (found < 0 || (found == 1 && value.uid != getuid()))
    return -1;
  printf("{\"kind\":\"process\",\"id\":%llu,\"now_ns\":\"%llu\",\"identity\":",
         (unsigned long long)values[0], (unsigned long long)now_ns());
  if (found == 0)
    printf("null");
  else
    printf("{\"pid\":%d,\"parent\":%d,\"pgid\":%d,\"uid\":%u,"
           "\"start_sec\":%llu,\"start_usec\":%llu}",
           value.pid, value.parent, value.pgid, value.uid,
           (unsigned long long)value.sec, (unsigned long long)value.usec);
  printf(",\"seq\":%u}\n", ++sequence);
  flush_output();
  return 0;
}
static int signal_reply(char *text) {
  uint64_t values[6];
  if (numbers(text, values, 6) || values[0] < 1 || values[0] > 1000000 ||
      values[1] < 2 || values[1] > INT_MAX || values[2] != getuid() ||
      values[4] > 999999 || (values[5] != SIGTERM && values[5] != SIGKILL))
    return -1;
  Identity value = {.pid = (pid_t)values[1],
                    .uid = (uid_t)values[2],
                    .sec = values[3],
                    .usec = values[4]};
  int state = still_owned(&value);
  if (state < 0)
    return -1;
  bool sent = false;
  if (state == 1) {
    if (clock_only && track_owned(value) < 0)
      return -1;
    if (kill(value.pid, (int)values[5]) == 0)
      sent = true;
    else if (errno != ESRCH)
      return -1;
  }
  printf("{\"kind\":\"signal\",\"id\":%llu,\"now_ns\":\"%llu\","
         "\"outcome\":\"%s\",\"seq\":%u}\n",
         (unsigned long long)values[0], (unsigned long long)now_ns(),
         sent ? "sent" : "absent", ++sequence);
  flush_output();
  return 0;
}
static int command(char *line, char **argv, bool inherited_stdio) {
  if (!strcmp(line, "STOP")) {
    stop_guard(NULL, false);
    return 0;
  }
  if (!strncmp(line, "STOP ", 5)) {
    char *end;
    errno = 0;
    unsigned long long origin = strtoull(line + 5, &end, 10);
    if (errno || *end || !origin || origin > now_ns())
      return -1;
    stop_guard_at(NULL, false, origin);
    return 0;
  }
  if (!strncmp(line, "NOW ", 4)) {
    char *end;
    errno = 0;
    unsigned long id = strtoul(line + 4, &end, 10);
    if (errno || *end || id < 1 || id > 1000000)
      return -1;
    printf("{\"kind\":\"clock\",\"id\":%lu,\"now_ns\":\"%llu\",\"seq\":%u}\n",
           id, (unsigned long long)now_ns(), ++sequence);
    flush_output();
    return 0;
  }
  if (!strncmp(line, "PID ", 4))
    return process_reply(line + 4);
  if (!strncmp(line, "SIGNAL ", 7))
    return signal_reply(line + 7);
  if (!strncmp(line, "DEADLINE ", 9) && !clock_only && !stopping) {
    uint64_t value;
    if (numbers(line + 9, &value, 1) || value > deadline_ns)
      return -1;
    deadline_ns = value;
    if (now_ns() >= deadline_ns)
      stop_guard_at("deadline", false, deadline_ns);
    return 0;
  }
  if (clock_only || stopping)
    return -1;
  if (!strcmp(line, "LAUNCH") && !launched)
    return launch(argv, inherited_stdio);
  if (!strcmp(line, "RESUME") && launched && !resumed) {
    if (owned_count == 0 || still_owned(&owned[0]) != 1 ||
        kill(owned[0].pid, SIGCONT))
      return -1;
    resumed = true;
    phase("running");
    return 0;
  }
  return -1;
}
int main(int argc, char **argv) {
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || !timebase.denom)
    return 70;
  clock_only = argc == 2 && !strcmp(argv[1], "--clock");
  bool inherited_stdio = false;
  char **target = NULL;
  if (!clock_only) {
    if (argc < 7 || strcmp(argv[1], "--watch"))
      return 64;
    char *end;
    unsigned long prior = strtoul(argv[3], &end, 10);
    if (*end || prior > 15)
      return 64;
    execs = (unsigned)prior;
    deadline_ns = strtoull(argv[4], &end, 10);
    if (*end || deadline_ns <= now_ns())
      return 64;
    int separator = 5;
    if (!strcmp(argv[5], "--stdio-fds")) {
      inherited_stdio = true;
      separator++;
    }
    if (argc > separator && !strcmp(argv[separator], "--receipt-control")) {
      uint64_t values[5];
      if (argc <= separator + 1 || numbers(argv[separator + 1], values, 5) ||
          values[2] != getuid() || values[4] > 999999999 ||
          (uint64_t)(dev_t)values[0] != values[0])
        return 64;
      control_identity = (Receipt){(dev_t)values[0],
                                   (ino_t)values[1],
                                   {(time_t)values[3], (long)values[4]}};
      control_pinned = true;
      separator += 2;
    }
    if (argc <= separator + 1 || strcmp(argv[separator], "--") ||
        argv[separator + 1][0] != '/')
      return 64;
    target = &argv[separator + 1];
  }
  unsigned char random_bytes[16];
  arc4random_buf(random_bytes, sizeof random_bytes);
  int written = snprintf(marker, sizeof marker, MARKER_NAME "=");
  for (size_t i = 0; i < sizeof random_bytes; i++)
    written += snprintf(marker + written, sizeof marker - written, "%02x",
                        random_bytes[i]);
  signal(SIGPIPE, SIG_IGN);
  struct sigaction action = {0};
  action.sa_handler = mark_interrupt;
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  if (pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0))
    return 70;
  queue_fd = kqueue();
  if (queue_fd < 0 || fcntl(queue_fd, F_SETFD, FD_CLOEXEC) ||
      fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK) ||
      fcntl(STDOUT_FILENO, F_SETFL, O_NONBLOCK) ||
      subscribe(STDIN_FILENO, EVFILT_READ, EV_ADD | EV_CLEAR, 0, 0) ||
      subscribe(1, EVFILT_TIMER, EV_ADD | EV_ENABLE, 0, 10) ||
      subscribe((uintptr_t)getpid(), EVFILT_PROC, EV_ADD | EV_CLEAR,
                NOTE_FORK | NOTE_EXEC | NOTE_EXIT, 0))
    return 70;
  if (!clock_only) {
    receipt_fd = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (receipt_fd < 0 || fstat(receipt_fd, &receipt_stat) ||
        receipt_stat.st_uid != getuid() ||
        subscribe((uintptr_t)receipt_fd, EVFILT_VNODE, EV_ADD | EV_CLEAR,
                  NOTE_WRITE | NOTE_EXTEND | NOTE_ATTRIB | NOTE_RENAME |
                      NOTE_DELETE | NOTE_REVOKE,
                  0) ||
        reconcile_receipts() || receipt_count != 0) {
      stop_guard("guard_loss", true);
    }
  }
  Identity creator;
  uint32_t creator_status;
  if (inspect(getpid(), &creator, &creator_status) != 1)
    stop_guard("guard_loss", true);
  if (!stopping) {
    printf("{\"kind\":\"ready\",\"mode\":\"%s\",\"now_ns\":\"%llu\","
           "\"owner\":{\"pid\":%d,\"parent\":%d,\"pgid\":%d,\"uid\":%u,"
           "\"start_sec\":%llu,\"start_usec\":%llu},\"seq\":%u}\n",
           clock_only ? "clock" : "watch", (unsigned long long)now_ns(),
           creator.pid, creator.parent, creator.pgid, creator.uid,
           (unsigned long long)creator.sec, (unsigned long long)creator.usec,
           ++sequence);
    flush_output();
  }
  char input[128];
  size_t used = 0;
  while (true) {
    if (interrupted || output_lost)
      stop_guard("guard_loss", true);
    if (!clock_only && now_ns() >= deadline_ns)
      stop_guard_at("deadline", false, deadline_ns);
    if (stopping) {
      if (verify_gone()) {
        disappearance_ms = latency();
        cleanup_verified = true;
        if (disappearance_ms > 5000)
          failed = true;
        break;
      }
      if (!kill_sent && latency() >= 2000)
        dispatch(SIGKILL);
      if (latency() >= 5000) {
        failed = true;
        break;
      }
    }
    struct kevent events[64];
    struct timespec timeout = {0, 10000000};
    int n = kevent(queue_fd, NULL, 0, events, 64, &timeout);
    if (n < 0) {
      if (errno == EINTR)
        continue;
      stop_guard("guard_loss", true);
      continue;
    }
    for (int i = 0; i < n; i++) {
      struct kevent *event = &events[i];
      if (event->flags & EV_ERROR) {
        stop_guard("guard_loss", true);
        continue;
      }
      if (event->filter == EVFILT_READ) {
        char data[128];
        ssize_t length;
        while ((length = read(STDIN_FILENO, data, sizeof data)) > 0) {
          for (ssize_t j = 0; j < length; j++) {
            if (data[j] == '\n') {
              input[used] = 0;
              if (command(input, target, inherited_stdio))
                stop_guard("protocol", true);
              used = 0;
            } else if (used + 1 < sizeof input && data[j] >= 32 &&
                       data[j] <= 126) {
              input[used++] = data[j];
            } else {
              stop_guard("protocol", true);
              used = 0;
            }
          }
        }
        if (length == 0)
          stop_guard("coordinator_lost", true);
        else if (errno != EAGAIN && errno != EINTR)
          stop_guard("guard_loss", true);
      } else if (event->filter == EVFILT_PROC) {
        bool known = event->ident == (uintptr_t)getpid();
        for (size_t j = 0; j < owned_count; j++) {
          if (event->ident != (uintptr_t)owned[j].pid)
            continue;
          known = true;
          if (!owned[j].gone && (event->fflags & NOTE_EXEC)) {
            execs++;
            if (overrun())
              break;
          }
        }
        if (!known)
          stop_guard("guard_loss", true);
        if ((event->fflags & NOTE_FORK) && reconcile_tree())
          stop_guard("guard_loss", true);
        reap_root();
      } else if (event->filter == EVFILT_VNODE) {
        if (event->fflags &
            (NOTE_DELETE | NOTE_RENAME | NOTE_REVOKE | NOTE_ATTRIB))
          stop_guard("guard_loss", true);
        else if (reconcile_receipts())
          stop_guard("guard_loss", true);
      } else if (event->filter != EVFILT_TIMER)
        stop_guard("guard_loss", true);
    }
    if (!clock_only) {
      if (reconcile_tree() || reconcile_receipts() || sweep_unowned(false) < 0)
        stop_guard("guard_loss", true);
      count_record();
      if (launched && verify_gone() && !stopping)
        stop_guard(NULL, false);
    }
  }
  finish();
  if (receipt_fd >= 0)
    close(receipt_fd);
  close(queue_fd);
  return failed || unaccounted_seen || output_lost || !cleanup_verified ? 2
                                                                         : 0;
}
