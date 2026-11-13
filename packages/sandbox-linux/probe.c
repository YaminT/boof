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
#if defined(__linux__)
#include <sched.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#endif
#include <sys/resource.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
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
    case EMFILE:
      return "EMFILE";
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

/* Shared loopback address setup for the portable bind/connect probes. */
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

#if defined(__linux__)
/* Netlink, MPTCP, sendmmsg and SMC exist only on Linux. */
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

/* Many connects to one port, half of them non-blocking. Prints how many got through. */
static void op_connect_many(int family, int port, int count) {
  int leaked = 0;
  for (int i = 0; i < count; i++) {
    int fd = socket(family, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) continue;
    if (i % 2) fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
    struct sockaddr_storage ss;
    socklen_t len = 0;
    if (fill_loopback(family, port, &ss, &len) != 0) {
      close(fd);
      continue;
    }
    int rc = connect(fd, (struct sockaddr *)&ss, len);
    if (rc == 0 || errno == EINPROGRESS) leaked++;
    close(fd);
  }
  printf("stress %d %d\n", count, leaked);
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

static void op_orphan_sleep(const char *pid_path) {
  int ready[2];
  if (pipe(ready) != 0) return;
  pid_t pid = fork();
  if (pid < 0) return;
  if (pid == 0) {
    close(ready[0]);
    if (setsid() < 0) _exit(2);
    FILE *file = fopen(pid_path, "w");
    if (file == NULL) _exit(3);
    fprintf(file, "%ld\n", (long)getpid());
    fclose(file);
    close(STDIN_FILENO);
    close(STDOUT_FILENO);
    close(STDERR_FILENO);
    ssize_t wrote = write(ready[1], "x", 1);
    (void)wrote;
    close(ready[1]);
    for (;;) sleep(60);
  }
  close(ready[1]);
  char byte;
  ssize_t got = read(ready[0], &byte, 1);
  (void)got;
  close(ready[0]);
}

#if defined(__linux__)
static long host_tasks(void) {
  FILE *file = fopen("/proc/loadavg", "r");
  if (file == NULL) return -1;
  double a, b, c;
  long running = 0, total = -1;
  if (fscanf(file, "%lf %lf %lf %ld/%ld", &a, &b, &c, &running, &total) != 5) total = -1;
  fclose(file);
  return total;
}

/* Print the limits the helper left on this process. The knobs must already be unset. */
static void op_limits(void) {
  struct rlimit nproc;
  if (getrlimit(RLIMIT_NPROC, &nproc) != 0) {
    printf("limits %s\n", errname(errno));
    return;
  }
  struct rlimit nice_lim;
  if (getrlimit(RLIMIT_NICE, &nice_lim) != 0) {
    printf("limits %s\n", errname(errno));
    return;
  }
  errno = 0;
  int nice_value = getpriority(PRIO_PROCESS, 0);
  const char *floor = getenv("BOOF_SANDBOX_NPROC_FLOOR");
  const char *headroom = getenv("BOOF_SANDBOX_NPROC_HEADROOM");
  printf("limits nproc=%lu/%lu nice=%d nice_rlim=%lu/%lu host=%ld floor=%s headroom=%s\n",
         (unsigned long)nproc.rlim_cur, (unsigned long)nproc.rlim_max, nice_value,
         (unsigned long)nice_lim.rlim_cur, (unsigned long)nice_lim.rlim_max, host_tasks(),
         floor != NULL ? floor : "unset", headroom != NULL ? headroom : "unset");
}

#ifndef SCHED_IDLE
#define SCHED_IDLE 5
#endif

struct boof_sched_attr {
  unsigned int size;
  unsigned int sched_policy;
  unsigned long long sched_flags;
  int sched_nice;
  unsigned int sched_priority;
  unsigned long long sched_runtime;
  unsigned long long sched_deadline;
  unsigned long long sched_period;
};

/* IOPRIO_WHO_PROCESS is 1. who 0 is the caller. BE class, level 4. */
#define BOOF_IOPRIO_WHO_PROCESS 1
#define BOOF_IOPRIO_BE4 ((2 << 13) | 4)

static void report_call(const char *name, int rc) {
  printf("%s %s\n", name, rc == 0 ? "ok" : errname(errno));
}

/*
 * Self (pid/who 0) must still work. The helper and an outside pid must be EPERM.
 * A call that unexpectedly succeeds is undone when that is possible.
 */
static void op_task_control(const char *outside_text) {
  char *end = NULL;
  long outside_value = strtol(outside_text, &end, 10);
  if (end == outside_text || *end != '\0' || outside_value <= 1) {
    printf("task-control EINVAL\n");
    return;
  }
  pid_t outside = (pid_t)outside_value;
  pid_t parent = getppid();
  struct rlimit nofile;

  errno = 0;
  report_call("prlimit-self", prlimit(0, RLIMIT_NOFILE, NULL, &nofile));
  errno = 0;
  report_call("prlimit-parent", prlimit(parent, RLIMIT_NOFILE, NULL, &nofile));
  errno = 0;
  report_call("prlimit-outside", prlimit(outside, RLIMIT_NOFILE, NULL, &nofile));

  errno = 0;
  int rc = setpriority(PRIO_PROCESS, 0, 19);
  report_call("setpriority-self", rc);

  errno = 0;
  rc = setpriority(PRIO_PROCESS, parent, 19);
  if (rc == 0) setpriority(PRIO_PROCESS, parent, 0);
  report_call("setpriority-parent", rc);

  errno = 0;
  rc = setpriority(PRIO_PROCESS, outside, 19);
  if (rc == 0) setpriority(PRIO_PROCESS, outside, 0);
  report_call("setpriority-outside", rc);

  struct sched_param param;
  memset(&param, 0, sizeof param);
  errno = 0;
  report_call("sched-scheduler-self", sched_setscheduler(0, SCHED_OTHER, &param));
  errno = 0;
  rc = sched_setscheduler(parent, SCHED_IDLE, &param);
  if (rc == 0) sched_setscheduler(parent, SCHED_OTHER, &param);
  report_call("sched-scheduler-parent", rc);
  errno = 0;
  report_call("sched-param-parent", sched_setparam(parent, &param));

  struct boof_sched_attr attr;
  memset(&attr, 0, sizeof attr);
  attr.size = sizeof attr;
  attr.sched_policy = SCHED_OTHER;
  errno = 0;
  rc = (int)syscall(SYS_sched_setattr, parent, &attr, 0);
  if (rc == 0) {
    attr.sched_policy = SCHED_OTHER;
    syscall(SYS_sched_setattr, parent, &attr, 0);
  }
  report_call("sched-attr-parent", rc);

  cpu_set_t set;
  CPU_ZERO(&set);
  CPU_SET(0, &set);
  errno = 0;
  report_call("sched-affinity-self", sched_setaffinity(0, sizeof set, &set));
  errno = 0;
  rc = sched_setaffinity(parent, sizeof set, &set);
  if (rc == 0) {
    cpu_set_t all;
    CPU_ZERO(&all);
    long ncpu = sysconf(_SC_NPROCESSORS_CONF);
    if (ncpu < 1) ncpu = 1;
    for (long cpu = 0; cpu < ncpu && cpu < CPU_SETSIZE; cpu++) CPU_SET(cpu, &all);
    sched_setaffinity(parent, sizeof all, &all);
  }
  report_call("sched-affinity-parent", rc);

  errno = 0;
  report_call("ioprio-self", (int)syscall(SYS_ioprio_set, BOOF_IOPRIO_WHO_PROCESS, 0, BOOF_IOPRIO_BE4));
  errno = 0;
  rc = (int)syscall(SYS_ioprio_set, BOOF_IOPRIO_WHO_PROCESS, parent, BOOF_IOPRIO_BE4);
  report_call("ioprio-parent", rc);
  errno = 0;
  rc = (int)syscall(SYS_ioprio_set, BOOF_IOPRIO_WHO_PROCESS, outside, BOOF_IOPRIO_BE4);
  report_call("ioprio-outside", rc);
}

/*
 * A storm that keeps forking until killed. Every process forks whenever the host task count is
 * below the start count plus `ceiling`, so a slot that a kill frees is refilled at once. Half the
 * children setsid(). All of them are named "boofstorm". The ceiling bounds the host, not the
 * helper: a helper that sets no process cap lets the storm reach it.
 */
static void op_storm_live(const char *ceiling_text) {
  long ceiling = strtol(ceiling_text, NULL, 10);
  long base = host_tasks();
  if (ceiling < 1 || base < 0) return;
  prctl(PR_SET_NAME, "boofstorm", 0, 0, 0);
  printf("storm-live start\n");
  fflush(stdout);
  for (;;) {
    long total = host_tasks();
    if (total >= 0 && total < base + ceiling) {
      pid_t pid = fork();
      if (pid == 0) {
        if ((getpid() & 1) == 0) setsid();
        continue;
      }
      if (pid > 0) continue;
    }
    struct timespec delay = {.tv_sec = 0, .tv_nsec = 1000000};
    nanosleep(&delay, NULL);
  }
}

#endif

static void op_fork_storm(const char *pid_path) {
  int fd = open(pid_path, O_WRONLY | O_APPEND);
  if (fd < 0) {
    printf("fork-storm open %s\n", errname(errno));
    return;
  }
  pid_t workers[4];
  int worker_count = 0;
  for (int worker = 0; worker < 4; worker++) {
    pid_t branch = fork();
    if (branch < 0) break;
    if (branch == 0) {
      for (int n = 0; n < 1200; n++) {
        pid_t pid = fork();
        if (pid < 0) break;
        if (pid == 0) {
          close(fd);
          for (;;) sleep(60);
        }
        char line[32];
        int len = snprintf(line, sizeof line, "%ld\n", (long)pid);
        if (len > 0) {
          ssize_t wrote = write(fd, line, (size_t)len);
          (void)wrote;
        }
      }
      close(fd);
      _exit(0);
    }
    workers[worker_count++] = branch;
  }
  close(fd);
  for (int i = 0; i < worker_count; i++) (void)waitpid(workers[i], NULL, 0);
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
  } else if (strcmp(cmd, "stress4") == 0 && argc == 3) {
    int port = port_arg(argv[2]);
    if (port < 0) usage();
    op_connect_many(AF_INET, port, 200);
  } else if (strcmp(cmd, "stress6") == 0 && argc == 3) {
    int port = port_arg(argv[2]);
    if (port < 0) usage();
    op_connect_many(AF_INET6, port, 200);
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
  else if (strcmp(cmd, "orphan-sleep") == 0 && argc == 3) op_orphan_sleep(argv[2]);
  else if (strcmp(cmd, "fork-storm") == 0 && argc == 3) op_fork_storm(argv[2]);
  else if (strcmp(cmd, "double-read") == 0 && argc == 3) op_double("read", argv[2]);
  else if (strcmp(cmd, "double-connect4") == 0 && argc == 3) op_double("connect4", argv[2]);
#if defined(__linux__)
  else if (strcmp(cmd, "storm-live") == 0 && argc == 3) op_storm_live(argv[2]);
  else if (strcmp(cmd, "limits") == 0 && argc == 2) op_limits();
  else if (strcmp(cmd, "task-control") == 0 && argc == 3) op_task_control(argv[2]);
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
    op_socket_line("seqpacket-inet", AF_INET, SOCK_SEQPACKET, 0);
    op_socket_line("netlink", AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE);
    op_socket_line("netlink-diag", AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_SOCK_DIAG);
  } else if (strcmp(cmd, "listen-loop") == 0 && argc == 2) {
    unsigned count = 0;
    for (;; count++) {
      int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
      if (fd < 0) {
        printf("listen-loop %u %s\n", count, errname(errno));
        break;
      }
      if (listen(fd, 1) != 0) {
        printf("listen-loop %u %s\n", count, errname(errno));
        close(fd);
        break;
      }
    }
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
