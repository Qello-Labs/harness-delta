#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static int report(const char *result, int code) {
  printf("\n{\"result\":\"%s\"}\n", result);
  return code;
}

static int probe(int argc, char **argv) {
  if (argc == 1 && strcmp(argv[0], "pass") == 0)
    return report("allowed", 0);
  if (argc < 2)
    return report("invalid", 78);
  if (strcmp(argv[0], "map") == 0) {
    void *handle = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (handle == NULL)
      return report("mapping_rejected", 77);
    int (*symbol)(void) = (int (*)(void))dlsym(handle, "window_probe");
    int valid = symbol != NULL && symbol() == 7;
    int closed = dlclose(handle);
    return report(valid && closed == 0 ? "allowed" : "invalid",
                  valid && closed == 0 ? 0 : 78);
  }
  if (strcmp(argv[0], "exec") != 0)
    return report("invalid", 78);
  pid_t child;
  int error = posix_spawn(&child, argv[1], NULL, NULL, argv + 1, environ);
  if (error == EPERM)
    return report("EPERM", 77);
  if (error == EACCES)
    return report("EACCES", 77);
  if (error != 0)
    return report("spawn_failed", 78);
  int status;
  if (waitpid(child, &status, 0) != child)
    return report("wait_failed", 78);
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
    return report("child_failed", 78);
  return report("allowed", 0);
}

int main(int argc, char **argv) {
  alarm(10);
  if (argc < 2)
    return report("invalid", 78);
  if (strcmp(argv[1], "descendant") != 0)
    return probe(argc - 1, argv + 1);
  pid_t child = fork();
  if (child == -1)
    return report("fork_failed", 78);
  if (child == 0) {
    int code = probe(argc - 2, argv + 2);
    fflush(stdout);
    _exit(code);
  }
  int status;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status))
    return 78;
  return WEXITSTATUS(status);
}
