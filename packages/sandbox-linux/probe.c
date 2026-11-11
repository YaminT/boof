#if defined(__linux__)
#define _GNU_SOURCE
#endif

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#if defined(__linux__)
#include <linux/netlink.h>
#endif
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

#if defined(__linux__)
#ifndef IPPROTO_MPTCP
#define IPPROTO_MPTCP 262
#endif
#ifndef IPPROTO_SCTP
#define IPPROTO_SCTP 132
#endif
#ifndef AF_SMC
#define AF_SMC 43
#endif
#ifndef AF_ALG
#define AF_ALG 38
#endif
#endif

#ifndef SOCK_CLOEXEC
#define SOCK_CLOEXEC 0
#endif

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
    case EISCONN:
      return "EISCONN";
    default:
      return "ERR";
  }
}

static int port_arg(const char *text) {
  char *end = NULL;
  long value = strtol(text, &end, 10);
  if (end == text || *end != '\0' || value < 0 || value > 65535) return -1;
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

#if defined(__linux__)
/* Netlink, MPTCP, sendmmsg and SMC exist only on Linux. The shared ops below stay portable. */
static int fill_loopback(int family, int port, struct sockaddr_storage *ss, socklen_t *len) {
  memset(ss, 0, sizeof *ss);
  if (family == AF_INET) {
    struct sockaddr_in *addr = (struct sockaddr_in *)ss;
    addr->sin_family = AF_INET;
    addr->sin_port = htons((unsigned short)port);
    addr->sin_addr.s_addr = htonl(0x7f000001);
    *len = sizeof *addr;
    return 0;
  }
  if (family == AF_INET6) {
    struct sockaddr_in6 *addr = (struct sockaddr_in6 *)ss;
    addr->sin6_family = AF_INET6;
    addr->sin6_port = htons((unsigned short)port);
    addr->sin6_addr = in6addr_loopback;
    *len = sizeof *addr;
    return 0;
  }
  return -1;
}

static void op_connect_proto(int family, int port, int proto, const char *label) {
  int fd = socket(family, SOCK_STREAM | SOCK_CLOEXEC, proto);
  if (fd < 0) {
    printf("%s %s\n", label, errname(errno));
    return;
  }
  struct sockaddr_storage ss;
  socklen_t len = 0;
  if (fill_loopback(family, port, &ss, &len) != 0) {
    printf("%s EINVAL\n", label);
    close(fd);
    return;
  }
  int rc = connect(fd, (struct sockaddr *)&ss, len);
  printf("%s %s\n", label, rc == 0 ? "ok" : errname(errno));
  close(fd);
}

static void op_bind_proto(int family, int port, int proto, const char *label) {
  int fd = socket(family, SOCK_STREAM | SOCK_CLOEXEC, proto);
  if (fd < 0) {
    printf("%s %s\n", label, errname(errno));
    return;
  }
  struct sockaddr_storage ss;
  socklen_t len = 0;
  if (fill_loopback(family, port, &ss, &len) != 0) {
    printf("%s EINVAL\n", label);
    close(fd);
    return;
  }
  int rc = bind(fd, (struct sockaddr *)&ss, len);
  printf("%s %s\n", label, rc == 0 ? "ok" : errname(errno));
  close(fd);
}

/* MSG_FASTOPEN connects without the connect syscall, so Landlock never sees it. */
static void op_tfo(int family, int port, int how, int flags, const char *label) {
  int fd = socket(family, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    printf("%s %s\n", label, errname(errno));
    return;
  }
  struct timeval tv = {.tv_sec = 1, .tv_usec = 0};
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
  struct sockaddr_storage ss;
  socklen_t slen = 0;
  if (fill_loopback(family, port, &ss, &slen) != 0) {
    printf("%s EINVAL\n", label);
    close(fd);
    return;
  }
  char payload[] = "GET / HTTP/1.0\r\n\r\n";
  struct iovec iov = {.iov_base = payload, .iov_len = sizeof payload - 1};
  ssize_t n = -1;
  if (how == 0) {
    n = sendto(fd, payload, sizeof payload - 1, flags, (struct sockaddr *)&ss, slen);
  } else if (how == 1) {
    struct msghdr msg;
    memset(&msg, 0, sizeof msg);
    msg.msg_name = &ss;
    msg.msg_namelen = slen;
    msg.msg_iov = &iov;
    msg.msg_iovlen = 1;
    n = sendmsg(fd, &msg, flags);
  } else {
    struct mmsghdr msg;
    memset(&msg, 0, sizeof msg);
    msg.msg_hdr.msg_name = &ss;
    msg.msg_hdr.msg_namelen = slen;
    msg.msg_hdr.msg_iov = &iov;
    msg.msg_hdr.msg_iovlen = 1;
    int rc = sendmmsg(fd, &msg, 1, flags);
    n = rc < 0 ? -1 : (ssize_t)msg.msg_len;
  }
  if (n < 0) printf("%s %s\n", label, errname(errno));
  else printf("%s ok\n", label);
  close(fd);
}

static void op_socket_line(const char *label, int domain, int type, int proto) {
  int fd = socket(domain, type, proto);
  if (fd < 0) printf("%s %s\n", label, errname(errno));
  else {
    close(fd);
    printf("%s ok\n", label);
  }
}

static void op_udp(int proto, int port, const char *label) {
  int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, proto);
  if (fd < 0) {
    printf("%s %s\n", label, errname(errno));
    return;
  }
  struct sockaddr_storage ss;
  socklen_t slen = 0;
  fill_loopback(AF_INET, port, &ss, &slen);
  char byte = 'u';
  ssize_t n = sendto(fd, &byte, 1, 0, (struct sockaddr *)&ss, slen);
  printf("%s %s\n", label, n == 1 ? "ok" : errname(errno));
  close(fd);
}

static int fill_unix(struct sockaddr_un *addr, const char *path) {
  memset(addr, 0, sizeof *addr);
  addr->sun_family = AF_UNIX;
  if (strlen(path) >= sizeof addr->sun_path) return -1;
  memcpy(addr->sun_path, path, strlen(path) + 1);
  return 0;
}

/* A datagram socketpair can connect or sendto a pathname socket. Stream cannot. */
static void op_pair_dgram(const char *path, int type, const char *label) {
  int sv[2];
  if (socketpair(AF_UNIX, type, 0, sv) != 0) {
    printf("%s %s\n", label, errname(errno));
    return;
  }
  struct sockaddr_un addr;
  if (path == NULL || fill_unix(&addr, path) != 0) {
    printf("%s ok\n", label);
    close(sv[0]);
    close(sv[1]);
    return;
  }
  ssize_t n = sendto(sv[0], "PWNED", 5, 0, (struct sockaddr *)&addr, sizeof addr);
  printf("%s %s\n", label, n < 0 ? errname(errno) : "sent");
  close(sv[0]);
  close(sv[1]);
}

static void op_pair_copy(int type, const char *label) {
  int sv[2];
  if (socketpair(AF_UNIX, type, 0, sv) != 0) {
    printf("%s %s\n", label, errname(errno));
    return;
  }
  int fl = fcntl(sv[0], F_GETFD);
  if ((type & SOCK_CLOEXEC) != 0 && (fl < 0 || (fl & FD_CLOEXEC) == 0)) {
    printf("%s noclose\n", label);
    close(sv[0]);
    close(sv[1]);
    return;
  }
  if (write(sv[0], "Z", 1) != 1) {
    printf("%s %s\n", label, errname(errno));
    close(sv[0]);
    close(sv[1]);
    return;
  }
  char byte = 0;
  ssize_t n = read(sv[1], &byte, 1);
  printf("%s %s\n", label, n == 1 && byte == 'Z' ? "ok" : errname(n < 0 ? errno : EIO));
  close(sv[0]);
  close(sv[1]);
}

static void op_pair_stream_connect(const char *path) {
  int sv[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) {
    printf("pair-stream-connect %s\n", errname(errno));
    return;
  }
  struct sockaddr_un addr;
  if (fill_unix(&addr, path) != 0) {
    printf("pair-stream-connect EINVAL\n");
    close(sv[0]);
    close(sv[1]);
    return;
  }
  int rc = connect(sv[0], (struct sockaddr *)&addr, sizeof addr);
  printf("pair-stream-connect %s\n", rc == 0 ? "ok" : errname(errno));
  close(sv[0]);
  close(sv[1]);
}
#endif

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

static void op_bind_zero(int family, const char *label) {
  int fd = socket(family, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    printf("%s %s\n", label, errname(errno));
    return;
  }
  struct sockaddr_storage ss;
  socklen_t len = 0;
  fill_loopback(family, 0, &ss, &len);
  if (bind(fd, (struct sockaddr *)&ss, len) != 0) {
    printf("%s %s\n", label, errname(errno));
    close(fd);
    return;
  }
  if (listen(fd, 1) != 0) {
    printf("%s listen-%s\n", label, errname(errno));
    close(fd);
    return;
  }
  if (getsockname(fd, (struct sockaddr *)&ss, &len) != 0) {
    printf("%s getsockname-%s\n", label, errname(errno));
    close(fd);
    return;
  }
  unsigned port = family == AF_INET
                      ? ntohs(((struct sockaddr_in *)&ss)->sin_port)
                      : ntohs(((struct sockaddr_in6 *)&ss)->sin6_port);
  printf("%s ok %u listen ok\n", label, port);
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

static int pipe_cloexec(int fds[2]) {
#if defined(__linux__)
  return pipe2(fds, O_CLOEXEC);
#else
  if (pipe(fds) != 0) return -1;
  if (fcntl(fds[0], F_SETFD, FD_CLOEXEC) != 0 || fcntl(fds[1], F_SETFD, FD_CLOEXEC) != 0) {
    int saved = errno;
    close(fds[0]);
    close(fds[1]);
    errno = saved;
    return -1;
  }
  return 0;
#endif
}

static void op_double(const char *mode, const char *arg) {
  int fds[2];
  if (pipe_cloexec(fds) != 0) {
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

#if defined(__linux__)
static void op_dgram_listen(const char *path) {
  int fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    printf("listen %s\n", errname(errno));
    return;
  }
  struct sockaddr_un addr;
  if (fill_unix(&addr, path) != 0) {
    printf("listen EINVAL\n");
    close(fd);
    return;
  }
  unlink(path);
  if (bind(fd, (struct sockaddr *)&addr, sizeof addr) != 0) {
    printf("listen %s\n", errname(errno));
    close(fd);
    return;
  }
  printf("bound\n");
  fflush(stdout);
  struct timeval tv = {.tv_sec = 2, .tv_usec = 0};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  char buf[64];
  ssize_t n = recv(fd, buf, sizeof buf - 1, 0);
  if (n < 0) printf("none\n");
  else {
    buf[n] = '\0';
    printf("got %s\n", buf);
  }
  fflush(stdout);
  close(fd);
  unlink(path);
}

static void op_smc(int port) {
  int fd = socket(AF_SMC, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    printf("smc %s\n", errname(errno));
    return;
  }
  struct sockaddr_storage ss;
  socklen_t len = 0;
  if (fill_loopback(AF_INET, port, &ss, &len) != 0) {
    printf("smc EINVAL\n");
    close(fd);
    return;
  }
  int rc = connect(fd, (struct sockaddr *)&ss, len);
  printf("smc %s\n", rc == 0 ? "ok" : errname(errno));
  close(fd);
}
#endif

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
  } else if (strcmp(cmd, "bind0v4") == 0 && argc == 2) {
    op_bind_zero(AF_INET, "bind0v4");
  } else if (strcmp(cmd, "bind0v6") == 0 && argc == 2) {
    op_bind_zero(AF_INET6, "bind0v6");
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
#if defined(__linux__)
  else if (strcmp(cmd, "pair-connect4") == 0 && argc == 4) {
    int denied = port_arg(argv[2]);
    int allowed = port_arg(argv[3]);
    if (denied < 0 || allowed < 0) usage();
    op_connect(AF_INET, denied, "denied");
    op_connect(AF_INET, allowed, "allowed");
  } else if (strcmp(cmd, "a3-bypass") == 0 && argc == 3) {
    int port = port_arg(argv[2]);
    if (port < 0) usage();
    op_connect_proto(AF_INET, port, IPPROTO_TCP, "tcp4");
    op_connect_proto(AF_INET, port, IPPROTO_MPTCP, "mptcp4");
    op_connect_proto(AF_INET6, port, IPPROTO_MPTCP, "mptcp6");
    op_tfo(AF_INET, port, 0, MSG_FASTOPEN, "tfo4");
    op_tfo(AF_INET6, port, 0, MSG_FASTOPEN, "tfo6");
    op_tfo(AF_INET, port, 1, MSG_FASTOPEN | MSG_NOSIGNAL, "tfomsg");
    op_tfo(AF_INET, port, 2, MSG_FASTOPEN | MSG_NOSIGNAL, "tfommsg");
    op_smc(port);
    op_socket_line("sctp", AF_INET, SOCK_STREAM, IPPROTO_SCTP);
    op_socket_line("alg", AF_ALG, SOCK_SEQPACKET, 0);
  } else if (strcmp(cmd, "a4-mptcp") == 0 && argc == 3) {
    int port = port_arg(argv[2]);
    if (port < 0) usage();
    op_bind_proto(AF_INET, port, IPPROTO_MPTCP, "mptcp-bind4");
    op_bind_proto(AF_INET6, port, IPPROTO_MPTCP, "mptcp-bind6");
  } else if (strcmp(cmd, "sock-allow") == 0 && argc == 3) {
    int port = port_arg(argv[2]);
    if (port < 0) usage();
    op_udp(0, port, "udp");
    op_udp(IPPROTO_UDP, port, "udp17");
    op_connect_proto(AF_INET, port, IPPROTO_TCP, "tcp");
    op_socket_line("icmp", AF_INET, SOCK_DGRAM, IPPROTO_ICMP);
    op_socket_line("icmp6", AF_INET6, SOCK_DGRAM, IPPROTO_ICMPV6);
    op_socket_line("netlink", AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE);
    op_socket_line("netlink-diag", AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_SOCK_DIAG);
  } else if (strcmp(cmd, "dgram-listen") == 0 && argc == 3) op_dgram_listen(argv[2]);
  else if (strcmp(cmd, "pairs") == 0 && argc == 4) {
    op_pair_dgram(argv[2], SOCK_DGRAM, "pair-dgram");
    op_pair_dgram(NULL, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, "pair-dgram-flags");
    op_pair_copy(SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, "pair-stream");
    op_pair_copy(SOCK_SEQPACKET | SOCK_CLOEXEC, "pair-seq");
    op_pair_stream_connect(argv[3]);
  }
#endif
  else usage();
  if (fflush(stdout) != 0) return 1;
  return 0;
}
