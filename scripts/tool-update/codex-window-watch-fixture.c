#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

/* Every operation follows an IPC credit. The independent alarm only bounds a
   broken qualification controller; it never establishes readiness. */
static void expired(int signo) {
  (void)signo;
  _exit(75);
}
static void credit(void) {
  char byte;
  ssize_t count;
  do {
    count = read(0, &byte, 1);
  } while (count < 0 && errno == EINTR);
  if (count != 1 || byte != '+')
    _exit(76);
}
extern char **environ;
static void note(const char *path, const char *text) {
  int fd = open(path, O_WRONLY | O_APPEND | O_CREAT, 0600);
  if (fd < 0 || write(fd, text, strlen(text)) < 0 || close(fd))
    _exit(78);
}
static void report(char byte) {
  if (write(1, &byte, 1) != 1)
    _exit(77);
}
int main(int argc, char **argv) {
  signal(SIGALRM, expired);
  alarm(10);
  if (argc < 3)
    return 64;
  int remaining = atoi(argv[2]);
  if (remaining < 0 || remaining > 24)
    return 64;
  if (!strcmp(argv[1], "exec")) {
    report('E');
    credit();
    if (!remaining)
      return 0;
    char next[16];
    snprintf(next, sizeof next, "%d", remaining - 1);
    execl(argv[0], argv[0], "exec", next, (char *)NULL);
    return 70;
  }
  if (!strcmp(argv[1], "fork")) {
    signal(SIGCHLD, SIG_IGN);
    for (int i = 0; i < remaining; i++) {
      credit();
      pid_t child = fork();
      if (child < 0)
        return 70;
      if (!child) {
        alarm(8);
        report('F');
        for (;;)
          pause();
      }
    }
    for (;;)
      pause();
  }
  if (!strcmp(argv[1], "receipt") && argc == 4) {
    for (int i = 0; i < remaining; i++) {
      credit();
      char path[4096];
      if (snprintf(path, sizeof path, "%s/%d.json", argv[3], i) >=
          (int)sizeof path)
        return 64;
      int fd = open(path, O_CREAT | O_EXCL | O_WRONLY, 0600);
      if (fd < 0 || close(fd))
        return 70;
      report('R');
    }
    for (;;)
      pause();
  }
  /* A bounded child that outlives one reconcile interval but never the case. */
  if (!strcmp(argv[1], "nap")) {
    alarm(5);
    usleep(300000);
    return 0;
  }
  /* The grandchild is reparented to launchd once its parent exits. */
  if ((!strcmp(argv[1], "reparent") || !strcmp(argv[1], "reparent-setsid")) &&
      argc == 4) {
    credit();
    int fds[2];
    if (pipe(fds))
      return 70;
    pid_t middle = fork();
    if (middle < 0)
      return 70;
    if (!middle) {
      pid_t grandchild = fork();
      if (grandchild < 0)
        _exit(70);
      if (!grandchild) {
        alarm(8);
        if (!strcmp(argv[1], "reparent-setsid") && setsid() < 0)
          _exit(70);
        pid_t self = getpid();
        if (write(fds[1], &self, sizeof self) != (ssize_t)sizeof self)
          _exit(70);
        for (;;)
          pause();
      }
      _exit(0);
    }
    pid_t escaped;
    if (read(fds[0], &escaped, sizeof escaped) != (ssize_t)sizeof escaped ||
        waitpid(middle, NULL, 0) != middle)
      return 70;
    char text[32];
    snprintf(text, sizeof text, "%d\n", escaped);
    note(argv[3], text);
    report('R');
    for (;;)
      pause();
  }
  if ((!strcmp(argv[1], "spawn") || !strcmp(argv[1], "forkexec")) &&
      argc == 4) {
    credit();
    for (int i = 0; i < remaining; i++) {
      pid_t child;
      if (!strcmp(argv[1], "spawn")) {
        char *child_argv[] = {argv[0], "nap", "0", NULL};
        if (posix_spawn(&child, argv[0], NULL, NULL, child_argv, environ))
          return 70;
      } else {
        child = fork();
        if (child < 0)
          return 70;
        if (!child) {
          execl(argv[0], argv[0], "nap", "0", (char *)NULL);
          _exit(70);
        }
      }
      if (waitpid(child, NULL, 0) != child)
        return 70;
    }
    report('S');
    for (;;)
      pause();
  }
  if (!strcmp(argv[1], "hold")) {
    signal(SIGTERM, SIG_IGN);
    report('H');
    for (;;)
      pause();
  }
  return 64;
}
