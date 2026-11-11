#define _GNU_SOURCE

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

/* Prints one result line. The sandbox tests decide what is allowed. */

static const char *errname(int err) {
  switch (err) {
    case EACCES:
      return "EACCES";
    case EPERM:
      return "EPERM";
    case ENOENT:
      return "ENOENT";
    case ECONNREFUSED:
      return "ECONNREFUSED";
    case EADDRINUSE:
      return "EADDRINUSE";
    case EINVAL:
      return "EINVAL";
    case EAGAIN:
      return "EAGAIN";
    default:
      return "ERR";
  }
}

static int port_arg(const char *text) {
  char *end = NULL;
  long value = strtol(text, &end, 10);
  if (end == text || *end != '\0' || value < 1 || value > 65535) return -1;
  return (int)value;
}

static void op_read(const char *path) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) printf("read %s\n", errname(errno));
  else {
    close(fd);
    printf("read ok\n");
  }
}

static void op_readdir(const char *path) {
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) printf("readdir %s\n", errname(errno));
  else {
    close(fd);
    printf("readdir ok\n");
  }
}

static void op_write(const char *path) {
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (fd < 0) printf("write %s\n", errname(errno));
  else {
    close(fd);
    printf("write ok\n");
  }
}

static void op_overwrite(const char *path) {
  int fd = open(path, O_WRONLY | O_TRUNC | O_CLOEXEC);
  if (fd < 0) printf("overwrite %s\n", errname(errno));
  else {
    ssize_t n = write(fd, "x", 1);
    close(fd);
    if (n == 1) printf("overwrite ok\n");
    else printf("overwrite %s\n", errname(errno));
  }
}

static void op_connect(int family, int port, const char *label) {
  int fd = socket(family, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    printf("%s %s\n", label, errname(errno));
    return;
  }
  int rc;
  if (family == AF_INET) {
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_port = htons((unsigned short)port);
    addr.sin_addr.s_addr = htonl(0x7f000001);
    rc = connect(fd, (struct sockaddr *)&addr, sizeof addr);
  } else {
    struct sockaddr_in6 addr;
    memset(&addr, 0, sizeof addr);
    addr.sin6_family = AF_INET6;
    addr.sin6_port = htons((unsigned short)port);
    addr.sin6_addr = in6addr_loopback;
    rc = connect(fd, (struct sockaddr *)&addr, sizeof addr);
  }
  if (rc == 0) printf("%s ok\n", label);
  else printf("%s %s\n", label, errname(errno));
  close(fd);
}

static void op_bind(int family, int port, const char *label) {
  int fd = socket(family, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    printf("%s %s\n", label, errname(errno));
    return;
  }
  int rc;
  if (family == AF_INET) {
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_port = htons((unsigned short)port);
    addr.sin_addr.s_addr = htonl(0x7f000001);
    rc = bind(fd, (struct sockaddr *)&addr, sizeof addr);
  } else {
    struct sockaddr_in6 addr;
    memset(&addr, 0, sizeof addr);
    addr.sin6_family = AF_INET6;
    addr.sin6_port = htons((unsigned short)port);
    addr.sin6_addr = in6addr_loopback;
    rc = bind(fd, (struct sockaddr *)&addr, sizeof addr);
  }
  if (rc == 0) printf("%s ok\n", label);
  else printf("%s %s\n", label, errname(errno));
  close(fd);
}

static void op_exchange(int port) {
  int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    printf("exchange %s\n", errname(errno));
    return;
  }
  struct timeval tv = {.tv_sec = 2, .tv_usec = 0};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof addr);
  addr.sin_family = AF_INET;
  addr.sin_port = htons((unsigned short)port);
  addr.sin_addr.s_addr = htonl(0x7f000001);
  if (connect(fd, (struct sockaddr *)&addr, sizeof addr) != 0) {
    printf("exchange %s\n", errname(errno));
    close(fd);
    return;
  }
  const char ping[] = "ping\n";
  if (write(fd, ping, sizeof ping - 1) != (ssize_t)(sizeof ping - 1)) {
    printf("exchange %s\n", errname(errno));
    close(fd);
    return;
  }
  char buf[64];
  ssize_t n = read(fd, buf, sizeof buf - 1);
  close(fd);
  if (n < 0) {
    printf("exchange %s\n", errname(errno));
    return;
  }
  buf[n] = '\0';
  for (ssize_t i = 0; i < n; i++) {
    if (buf[i] == '\n' || buf[i] == '\r') buf[i] = '\0';
  }
  printf("exchange ok %s\n", buf);
}

static void op_unix(const char *path) {
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    printf("unix %s\n", errname(errno));
    return;
  }
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof addr);
  addr.sun_family = AF_UNIX;
  if (strlen(path) >= sizeof addr.sun_path) {
    printf("unix EINVAL\n");
    close(fd);
    return;
  }
  memcpy(addr.sun_path, path, strlen(path) + 1);
  int rc = connect(fd, (struct sockaddr *)&addr, sizeof addr);
  printf("unix %s\n", rc == 0 ? "ok" : errname(errno));
  close(fd);
}

static void op_abstract(const char *name) {
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    printf("abstract %s\n", errname(errno));
    return;
  }
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof addr);
  addr.sun_family = AF_UNIX;
  size_t len = strlen(name);
  if (len == 0 || len + 1 >= sizeof addr.sun_path) {
    printf("abstract EINVAL\n");
    close(fd);
    return;
  }
  addr.sun_path[0] = '\0';
  memcpy(addr.sun_path + 1, name, len);
  socklen_t addrlen = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + len);
  int rc = connect(fd, (struct sockaddr *)&addr, addrlen);
  printf("abstract %s\n", rc == 0 ? "ok" : errname(errno));
  close(fd);
}

static void op_environ(const char *text) {
  char *end = NULL;
  long pid = strtol(text, &end, 10);
  if (end == text || *end != '\0' || pid < 1) {
    printf("environ EINVAL\n");
    return;
  }
  char path[64];
  snprintf(path, sizeof path, "/proc/%ld/environ", pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd >= 0) close(fd);
  printf("environ %s\n", fd < 0 ? errname(errno) : "ok");
}

static void op_signal(const char *text) {
  char *end = NULL;
  long pid = strtol(text, &end, 10);
  if (end == text || *end != '\0' || pid < 1) {
    printf("signal EINVAL\n");
    return;
  }
  int rc = kill((pid_t)pid, SIGUSR1);
  printf("signal %s\n", rc == 0 ? "ok" : errname(errno));
}

static void child_op(const char *mode, const char *arg) {
  if (strcmp(mode, "read") == 0) op_read(arg);
  else if (strcmp(mode, "connect4") == 0) op_connect(AF_INET, port_arg(arg), "connect");
}

static void op_setsid(const char *mode, const char *arg) {
  pid_t pid = fork();
  if (pid < 0) {
    printf("setsid %s\n", errname(errno));
    return;
  }
  if (pid == 0) {
    if (setsid() < 0) {
      printf("setsid %s\n", errname(errno));
      _exit(0);
    }
    child_op(mode, arg);
    fflush(stdout);
    _exit(0);
  }
  waitpid(pid, NULL, 0);
}

static void op_double(const char *mode, const char *arg) {
  int fds[2];
  if (pipe2(fds, O_CLOEXEC) != 0) {
    printf("double %s\n", errname(errno));
    return;
  }
  pid_t mid = fork();
  if (mid < 0) {
    printf("double %s\n", errname(errno));
    return;
  }
  if (mid == 0) {
    pid_t grand = fork();
    if (grand == 0) {
      close(fds[0]);
      if (dup2(fds[1], STDOUT_FILENO) < 0) _exit(1);
      child_op(mode, arg);
      fflush(stdout);
      _exit(0);
    }
    _exit(grand < 0 ? 1 : 0);
  }
  close(fds[1]);
  waitpid(mid, NULL, 0);
  char buf[256];
  ssize_t n = read(fds[0], buf, sizeof buf - 1);
  close(fds[0]);
  if (n < 0) {
    printf("double %s\n", errname(errno));
    return;
  }
  buf[n] = '\0';
  fputs(buf, stdout);
}

static void usage(void) {
  fprintf(stderr, "probe: bad arguments\n");
  exit(2);
}

int main(int argc, char **argv) {
  if (argc < 2) usage();
  const char *cmd = argv[1];
  if (strcmp(cmd, "read") == 0 && argc == 3) op_read(argv[2]);
  else if (strcmp(cmd, "readdir") == 0 && argc == 3) op_readdir(argv[2]);
  else if (strcmp(cmd, "write") == 0 && argc == 3) op_write(argv[2]);
  else if (strcmp(cmd, "overwrite") == 0 && argc == 3) op_overwrite(argv[2]);
  else if (strcmp(cmd, "connect4") == 0 && argc == 3) {
    int port = port_arg(argv[2]);
    if (port < 0) usage();
    op_connect(AF_INET, port, "connect");
  } else if (strcmp(cmd, "connect6") == 0 && argc == 3) {
    int port = port_arg(argv[2]);
    if (port < 0) usage();
    op_connect(AF_INET6, port, "connect");
  } else if (strcmp(cmd, "bind4") == 0 && argc == 3) {
    int port = port_arg(argv[2]);
    if (port < 0) usage();
    op_bind(AF_INET, port, "bind");
  } else if (strcmp(cmd, "bind6") == 0 && argc == 3) {
    int port = port_arg(argv[2]);
    if (port < 0) usage();
    op_bind(AF_INET6, port, "bind");
  } else if (strcmp(cmd, "exchange4") == 0 && argc == 3) {
    int port = port_arg(argv[2]);
    if (port < 0) usage();
    op_exchange(port);
  } else if (strcmp(cmd, "unix") == 0 && argc == 3) op_unix(argv[2]);
  else if (strcmp(cmd, "abstract") == 0 && argc == 3) op_abstract(argv[2]);
  else if (strcmp(cmd, "environ") == 0 && argc == 3) op_environ(argv[2]);
  else if (strcmp(cmd, "signal") == 0 && argc == 3) op_signal(argv[2]);
  else if (strcmp(cmd, "setsid-read") == 0 && argc == 3) op_setsid("read", argv[2]);
  else if (strcmp(cmd, "setsid-connect4") == 0 && argc == 3) op_setsid("connect4", argv[2]);
  else if (strcmp(cmd, "double-read") == 0 && argc == 3) op_double("read", argv[2]);
  else if (strcmp(cmd, "double-connect4") == 0 && argc == 3) op_double("connect4", argv[2]);
  else if (strcmp(cmd, "pair-connect4") == 0 && argc == 4) {
    int denied = port_arg(argv[2]);
    int allowed = port_arg(argv[3]);
    if (denied < 0 || allowed < 0) usage();
    op_connect(AF_INET, denied, "denied");
    op_connect(AF_INET, allowed, "allowed");
  } else usage();
  if (fflush(stdout) != 0) return 1;
  return 0;
}
