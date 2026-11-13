#define _GNU_SOURCE

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/netlink.h>
#include <linux/seccomp.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <signal.h>
#include <time.h>
#include <linux/openat2.h>
#include <unistd.h>

/*
 * boof-sandbox applies one policy and execs the command after "--".
 * The policy on --policy-fd is exactly:
 *   {"version":1,"readExec":["/abs"...],"readWrite":["/abs"...],"denyTcpPorts":[n...]}
 * The launcher adds environment variables itself. Any other field is rejected.
 * Ports 1..65535 not listed in denyTcpPorts get TCP bind and connect. Port 0
 * gets bind only when no denied port is in the kernel ephemeral range; port 0
 * never gets connect permission.
 * socket() allows only AF_INET, AF_INET6 and AF_NETLINK with NETLINK_ROUTE,
 * and only IPPROTO_IP, TCP, UDP, ICMP and ICMPv6. AF_UNIX stays EPERM.
 * MSG_FASTOPEN is EPERM. socketpair() allows only SOCK_STREAM and SOCK_SEQPACKET.
 */

#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif
#ifndef LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET
#define LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#endif
#ifndef LANDLOCK_SCOPE_SIGNAL
#define LANDLOCK_SCOPE_SIGNAL (1ULL << 1)
#endif

#define BOOF_FS_ABI1                                                          \
  (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE |               \
   LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR |               \
   LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |           \
   LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |               \
   LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |               \
   LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |             \
   LANDLOCK_ACCESS_FS_MAKE_SYM)
#define BOOF_FS_DIR_ONLY                                                      \
  (LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR |              \
   LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR |            \
   LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |                \
   LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |              \
   LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM |              \
   LANDLOCK_ACCESS_FS_REFER)
#define BOOF_NET_TCP                                                          \
  (LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP)

/* libc headers on this host stop at ABI 4. The kernel appends scoped. */
struct boof_ruleset_attr {
  __u64 handled_access_fs;
  __u64 handled_access_net;
  __u64 scoped;
};

#define MAX_POLICY (8 * 1024 * 1024)
#define MAX_PATHS 4096
#define MAX_PATH_LEN 4096

struct syscall_table {
  __u32 audit_arch;
  __u32 x32_bit; /* non-zero: kill syscall numbers with this bit (x32 ABI) */
  __u32 socket_nr;
  __u32 socketpair_nr;
  __u32 sendto_nr;
  __u32 sendmsg_nr;
  __u32 sendmmsg_nr;
  /* Allowed only for the caller. See apply_seccomp. */
  __u32 setpriority_nr;
  __u32 sched_setscheduler_nr;
  __u32 sched_setparam_nr;
  __u32 sched_setattr_nr;
  __u32 sched_setaffinity_nr;
  __u32 prlimit64_nr;
  __u32 ioprio_set_nr;
  __u32 deny[17];
};

/* Numbers from arch/x86/entry/syscalls/syscall_64.tbl and asm-generic/unistd.h.
 * x32 sendmsg/sendmmsg use different numbers, and the x32 bit kills them first.
 */
static const struct syscall_table k_tables[] = {
    {AUDIT_ARCH_X86_64, 0x40000000u, 41, 53, 44, 46, 307, 141, 144, 142, 314, 203, 302, 251,
     {425, 426, 427, 101, 310, 311, 165, 166, 155, 161, 308, 250, 248, 249, 321, 298, 323}},
    {AUDIT_ARCH_AARCH64, 0, 198, 199, 206, 211, 269, 140, 119, 118, 274, 122, 261, 30,
     {425, 426, 427, 117, 270, 271, 40, 39, 41, 51, 268, 219, 217, 218, 280, 241, 282}},
};

#define BOOF_FILTER_MAX 128

static char *policy_buf;
static char *arena;
static size_t arena_len;
static size_t arena_cap;
static size_t path_off[MAX_PATHS];
static unsigned char path_write[MAX_PATHS];
static int npaths;
static unsigned char deny_port[65536];

static int ephemeral_range(unsigned *first, unsigned *last) {
  const char *path = "/proc/sys/net/ipv4/ip_local_port_range";
#ifdef BOOF_SANDBOX_TEST
  const char *test_path = getenv("BOOF_SANDBOX_PORT_RANGE_FILE");
  if (test_path != NULL && test_path[0] != '\0') path = test_path;
#endif
  FILE *file = fopen(path, "r");
  if (file == NULL) return 0;
  char line[128];
  int ok = 0;
  if (fgets(line, sizeof line, file) != NULL) {
    unsigned low, high;
    char extra;
    if (sscanf(line, " %u %u %c", &low, &high, &extra) == 2 && low >= 1 &&
        low <= high && high <= 65535) {
      *first = low;
      *last = high;
      ok = 1;
    }
  }
  int ch;
  while (ok && (ch = fgetc(file)) != EOF) {
    if (!isspace((unsigned char)ch)) ok = 0;
  }
  if (ferror(file)) ok = 0;
  if (fclose(file) != 0) return 0;
  return ok;
}

static int port_zero_bind_allowed(void) {
  unsigned first, last;
  if (!ephemeral_range(&first, &last)) return 0;
  for (unsigned port = first; port <= last; port++) {
    if (deny_port[port]) return 0;
  }
  return 1;
}

static int open_rule_path(const char *path) {
  struct open_how how = {
      .flags = O_PATH | O_CLOEXEC,
      .resolve = RESOLVE_NO_SYMLINKS,
  };
  return (int)syscall(SYS_openat2, AT_FDCWD, path, &how, sizeof how);
}

static void fail(const char *msg) {
  free(policy_buf);
  policy_buf = NULL;
  free(arena);
  arena = NULL;
  fprintf(stderr, "boof-sandbox: %s\n", msg);
  exit(126);
}

static void failf(const char *fmt, ...) {
  char buf[512];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  for (char *p = buf; *p; p++) {
    if (*p == '\n' || *p == '\r') *p = ' ';
  }
  fail(buf);
}

static void fail_path(const char *prefix, const char *path) {
  char buf[MAX_PATH_LEN + 64];
  snprintf(buf, sizeof buf, "%s: %s", prefix, path);
  for (char *p = buf; *p; p++) {
    if (*p == '\n' || *p == '\r') *p = ' ';
  }
  fail(buf);
}

/* Fault names are read only from the test build. A production helper ignores the variable. */
#ifdef BOOF_SANDBOX_TEST
static int sandbox_fault(const char *name) {
  const char *value = getenv("BOOF_SANDBOX_FAULT");
  return value != NULL && strcmp(value, name) == 0;
}
#endif

static const struct syscall_table *native_table(void) {
#if defined(__x86_64__)
  return &k_tables[0];
#elif defined(__aarch64__)
  return &k_tables[1];
#else
#error "boof-sandbox supports x86_64 and aarch64 only"
#endif
}

static int landlock_abi(void) {
  long abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) failf("landlock: %s", strerror(errno));
  return (int)abi;
}

static char *arena_push(const char *bytes, size_t len) {
  if (len > MAX_PATH_LEN || arena_len > MAX_POLICY || len + 1 > MAX_POLICY - arena_len) {
    fail("invalid policy");
  }
  if (arena_len + len + 1 > arena_cap) {
    size_t cap = arena_cap == 0 ? 4096 : arena_cap;
    while (cap < arena_len + len + 1) {
      if (cap > MAX_POLICY / 2) fail("invalid policy");
      cap *= 2;
    }
    char *next = realloc(arena, cap);
    if (!next) fail("out of memory");
    arena = next;
    arena_cap = cap;
  }
  char *out = arena + arena_len;
  memcpy(out, bytes, len);
  out[len] = '\0';
  arena_len += len + 1;
  return out;
}

struct parser {
  const char *p;
  const char *end;
};

static void skip(struct parser *p) {
  while (p->p < p->end) {
    char c = *p->p;
    if (c != ' ' && c != '\t' && c != '\n' && c != '\r') break;
    p->p++;
  }
}

static int eat(struct parser *p, char c) {
  skip(p);
  if (p->p < p->end && *p->p == c) {
    p->p++;
    return 1;
  }
  return 0;
}

static int hex4(struct parser *p, unsigned *out) {
  unsigned value = 0;
  for (int i = 0; i < 4; i++) {
    if (p->p >= p->end) return 0;
    unsigned char c = (unsigned char)*p->p++;
    value <<= 4;
    if (c >= '0' && c <= '9') value += (unsigned)(c - '0');
    else if (c >= 'a' && c <= 'f') value += (unsigned)(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F') value += (unsigned)(c - 'A' + 10);
    else return 0;
  }
  *out = value;
  return 1;
}

static int append_cp(char *out, size_t *n, size_t cap, unsigned cp) {
  unsigned char tmp[4];
  int len;
  /* U+0000 would truncate the C string add_path and strcmp later see. */
  if (cp == 0) return 0;
  if (cp <= 0x7F) {
    tmp[0] = (unsigned char)cp;
    len = 1;
  } else if (cp <= 0x7FF) {
    tmp[0] = (unsigned char)(0xC0 | (cp >> 6));
    tmp[1] = (unsigned char)(0x80 | (cp & 0x3F));
    len = 2;
  } else if (cp <= 0xFFFF) {
    tmp[0] = (unsigned char)(0xE0 | (cp >> 12));
    tmp[1] = (unsigned char)(0x80 | ((cp >> 6) & 0x3F));
    tmp[2] = (unsigned char)(0x80 | (cp & 0x3F));
    len = 3;
  } else if (cp <= 0x10FFFF) {
    tmp[0] = (unsigned char)(0xF0 | (cp >> 18));
    tmp[1] = (unsigned char)(0x80 | ((cp >> 12) & 0x3F));
    tmp[2] = (unsigned char)(0x80 | ((cp >> 6) & 0x3F));
    tmp[3] = (unsigned char)(0x80 | (cp & 0x3F));
    len = 4;
  } else {
    return 0;
  }
  if (*n + (size_t)len >= cap) return 0;
  memcpy(out + *n, tmp, (size_t)len);
  *n += (size_t)len;
  return 1;
}

/* Returns 0 and a C string in out. Paths must be absolute and free of controls. */
static int parse_string(struct parser *p, char *out, size_t cap) {
  skip(p);
  if (p->p >= p->end || *p->p != '"') return 0;
  p->p++;
  size_t n = 0;
  while (p->p < p->end) {
    unsigned char c = (unsigned char)*p->p++;
    if (c == '"') {
      out[n] = '\0';
      return 1;
    }
    if (c == '\\') {
      if (p->p >= p->end) return 0;
      char esc = *p->p++;
      if (esc == 'u') {
        unsigned u;
        if (!hex4(p, &u)) return 0;
        unsigned cp;
        if (u >= 0xD800 && u <= 0xDBFF) {
          if (p->p + 1 >= p->end || p->p[0] != '\\' || p->p[1] != 'u') return 0;
          p->p += 2;
          unsigned lo;
          if (!hex4(p, &lo) || lo < 0xDC00 || lo > 0xDFFF) return 0;
          cp = 0x10000u + (((u - 0xD800u) << 10) | (lo - 0xDC00u));
        } else if (u >= 0xDC00 && u <= 0xDFFF) {
          return 0;
        } else {
          cp = u;
        }
        if (cp == 0) fail("policy string contains NUL");
        if (!append_cp(out, &n, cap, cp)) return 0;
        continue;
      }
      switch (esc) {
        case '"':
        case '\\':
        case '/':
          c = (unsigned char)esc;
          break;
        case 'b':
          c = '\b';
          break;
        case 'f':
          c = '\f';
          break;
        case 'n':
          c = '\n';
          break;
        case 'r':
          c = '\r';
          break;
        case 't':
          c = '\t';
          break;
        default:
          return 0;
      }
    } else if (c < 0x20) {
      return 0;
    }
    if (n + 1 >= cap) return 0;
    out[n++] = (char)c;
  }
  return 0;
}

static int add_path(const char *text, int writable) {
  size_t len = strlen(text);
  if (len == 0 || text[0] != '/' || len >= MAX_PATH_LEN) return 0;
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)text[i];
    if (c < 0x20 || c == 0x7F) return 0;
  }
  /* The builder realpaths. ".." would grant the inode reached by the walk. */
  for (size_t i = 0; i < len;) {
    while (i < len && text[i] == '/') i++;
    size_t start = i;
    while (i < len && text[i] != '/') i++;
    size_t n = i - start;
    if ((n == 1 && text[start] == '.') || (n == 2 && text[start] == '.' && text[start + 1] == '.'))
      return 0;
  }
  if (npaths >= MAX_PATHS) return 0;
  char *stored = arena_push(text, len);
  path_off[npaths] = (size_t)(stored - arena);
  path_write[npaths] = writable ? 1 : 0;
  npaths++;
  return 1;
}

static int parse_version(struct parser *p) {
  skip(p);
  if (p->p >= p->end || *p->p != '1') return 0;
  p->p++;
  if (p->p < p->end) {
    char c = *p->p;
    if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-')
      return 0;
  }
  return 1;
}

static int parse_port(struct parser *p, unsigned *out) {
  skip(p);
  if (p->p >= p->end || *p->p < '0' || *p->p > '9') return 0;
  if (*p->p == '0') {
    p->p++;
    if (p->p < p->end && *p->p >= '0' && *p->p <= '9') return 0;
    *out = 0;
    return 1;
  }
  unsigned value = 0;
  while (p->p < p->end && *p->p >= '0' && *p->p <= '9') {
    unsigned digit = (unsigned)(*p->p - '0');
    if (value > 65535u / 10u || (value == 65535u / 10u && digit > 65535u % 10u)) return 0;
    value = value * 10u + digit;
    p->p++;
  }
  *out = value;
  return 1;
}

static int parse_string_array(struct parser *p, int writable) {
  if (!eat(p, '[')) return 0;
  skip(p);
  if (eat(p, ']')) return 1;
  for (;;) {
    char text[MAX_PATH_LEN];
    if (!parse_string(p, text, sizeof text) || !add_path(text, writable)) return 0;
    skip(p);
    if (eat(p, ']')) return 1;
    if (!eat(p, ',')) return 0;
  }
}

static int parse_ports(struct parser *p) {
  if (!eat(p, '[')) return 0;
  skip(p);
  if (eat(p, ']')) return 1;
  for (;;) {
    unsigned port;
    if (!parse_port(p, &port) || port > 65535u) return 0;
    deny_port[port] = 1;
    skip(p);
    if (eat(p, ']')) return 1;
    if (!eat(p, ',')) return 0;
  }
}

static void parse_policy(const char *buf, size_t len) {
  struct parser p = {buf, buf + len};
  if (!eat(&p, '{')) fail("invalid policy");
  int seen_version = 0, seen_read = 0, seen_write = 0, seen_ports = 0;
  int first = 1;
  skip(&p);
  if (p.p < p.end && *p.p == '}') fail("invalid policy");
  while (p.p < p.end && *p.p != '}') {
    if (!first && !eat(&p, ',')) fail("invalid policy");
    first = 0;
    char key[64];
    if (!parse_string(&p, key, sizeof key)) fail("invalid policy");
    if (!eat(&p, ':')) fail("invalid policy");
    if (strcmp(key, "version") == 0) {
      if (seen_version++) fail("duplicate policy field");
      if (!parse_version(&p)) fail("unknown policy version");
    } else if (strcmp(key, "readExec") == 0) {
      if (seen_read++) fail("duplicate policy field");
      if (!parse_string_array(&p, 0)) fail("invalid policy");
    } else if (strcmp(key, "readWrite") == 0) {
      if (seen_write++) fail("duplicate policy field");
      if (!parse_string_array(&p, 1)) fail("invalid policy");
    } else if (strcmp(key, "denyTcpPorts") == 0) {
      if (seen_ports++) fail("duplicate policy field");
      if (!parse_ports(&p)) fail("invalid policy");
    } else {
      fail("unknown policy field");
    }
    skip(&p);
  }
  if (!eat(&p, '}')) fail("invalid policy");
  skip(&p);
  if (p.p != p.end) fail("invalid policy");
  if (!seen_version || !seen_read || !seen_write || !seen_ports) fail("invalid policy");
}

static __u64 handled_fs(int abi) {
  __u64 mask = BOOF_FS_ABI1 | LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE;
  if (abi >= 5) mask |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
  return mask;
}

static __u64 access_for(int abi, int writable, mode_t mode) {
  __u64 mask;
  if (S_ISDIR(mode)) {
    mask = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
    if (writable) mask = handled_fs(abi);
  } else {
    mask = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE;
    if (writable) mask |= LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE;
    if (writable && abi >= 5 && (S_ISCHR(mode) || S_ISBLK(mode)))
      mask |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
    mask &= ~BOOF_FS_DIR_ONLY;
  }
  return mask & handled_fs(abi);
}

static void apply_landlock(int abi) {
  if (abi < 4) failf("landlock abi %d is below 4", abi);

  int fds[MAX_PATHS];
  mode_t modes[MAX_PATHS];
  for (int i = 0; i < npaths; i++) {
    const char *path = arena + path_off[i];
    int fd = open_rule_path(path);
    if (fd < 0) {
      if (errno == ENOENT) fail_path("missing path", path);
      fail_path("cannot open path", path);
    }
    struct stat st;
    if (fstat(fd, &st) != 0) {
      close(fd);
      fail_path("cannot open path", path);
    }
    fds[i] = fd;
    modes[i] = st.st_mode;
  }

  /* restrict_self and seccomp both require this. Paths are open before it is set. */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) failf("no_new_privs: %s", strerror(errno));
  struct boof_ruleset_attr attr;
  memset(&attr, 0, sizeof attr);
  attr.handled_access_fs = handled_fs(abi);
  attr.handled_access_net = BOOF_NET_TCP;
  size_t attr_size = offsetof(struct boof_ruleset_attr, scoped);
  if (abi >= 6) {
    attr.scoped = LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET | LANDLOCK_SCOPE_SIGNAL;
    attr_size = sizeof attr;
  }
  int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attr, attr_size, 0);
  if (ruleset < 0) failf("landlock: %s", strerror(errno));

  for (int i = 0; i < npaths; i++) {
    struct landlock_path_beneath_attr beneath = {
        .allowed_access = access_for(abi, path_write[i], modes[i]),
        .parent_fd = fds[i],
    };
    if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &beneath, 0) != 0)
      failf("landlock: %s", strerror(errno));
  }

  struct landlock_net_port_attr net = {.allowed_access = BOOF_NET_TCP, .port = 0};
  for (unsigned port = 1; port <= 65535u; port++) {
    if (deny_port[port]) continue;
    net.port = port;
    if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_NET_PORT, &net, 0) != 0)
      failf("landlock: %s", strerror(errno));
  }
  if (port_zero_bind_allowed()) {
    net.allowed_access = LANDLOCK_ACCESS_NET_BIND_TCP;
    net.port = 0;
    if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_NET_PORT, &net, 0) != 0)
      failf("landlock: %s", strerror(errno));
  }

  if (syscall(SYS_landlock_restrict_self, ruleset, 0) != 0)
    failf("landlock: %s", strerror(errno));
  close(ruleset);
  for (int i = 0; i < npaths; i++) close(fds[i]);
}

static void emit(struct sock_filter *f, unsigned *n, __u16 code, __u8 jt, __u8 jf, __u32 k) {
  if (*n >= BOOF_FILTER_MAX) fail("seccomp: filter too large");
  f[*n] = (struct sock_filter){code, jt, jf, k};
  (*n)++;
}

static void apply_seccomp(void) {
  const struct syscall_table *table = native_table();
  struct sock_filter filter[BOOF_FILTER_MAX];
  unsigned n = 0;
  const __u32 arg0 = offsetof(struct seccomp_data, args[0]);
  const __u32 arg1 = offsetof(struct seccomp_data, args[1]);
  const __u32 arg2 = offsetof(struct seccomp_data, args[2]);
  const __u32 arg3 = offsetof(struct seccomp_data, args[3]);
  /* Keep the syscall number in A. Each special case returns; it does not fall through. */
  /* Foreign audit architectures die. x32 shares AUDIT_ARCH_X86_64, so its bit dies too. */
  emit(filter, &n, BPF_LD | BPF_W | BPF_ABS, 0, 0, offsetof(struct seccomp_data, arch));
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 1, 0, table->audit_arch);
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_KILL_PROCESS);
  emit(filter, &n, BPF_LD | BPF_W | BPF_ABS, 0, 0, offsetof(struct seccomp_data, nr));
  if (table->x32_bit != 0) {
    emit(filter, &n, BPF_JMP | BPF_JGE | BPF_K, 0, 1, table->x32_bit);
    emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_KILL_PROCESS);
  }
  /* socket: 22 instructions. A miss skips the whole block.
   *   ld domain
   *   jeq AF_INET, +6
   *   jeq AF_INET6, +5
   *   jeq AF_NETLINK, +1
   *   ret EPERM
   *   ld protocol          (netlink: only NETLINK_ROUTE)
   *   jeq NETLINK_ROUTE, +13
   *   ret EPERM
   *   ld type (mask flags); stream or datagram only
   *   jeq STREAM, +2 / DGRAM, +1
   *   ret EPERM
   *   ld protocol          (inet: IP, ICMP, TCP, UDP, ICMPv6)
   *   jeq IP, +5 / ICMP, +4 / TCP, +3 / UDP, +2 / ICMPV6, +1
   *   ret EPERM
   *   ret ALLOW
   */
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 0, 21, table->socket_nr);
  emit(filter, &n, BPF_LD | BPF_W | BPF_ABS, 0, 0, arg0);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 6, 0, AF_INET);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 5, 0, AF_INET6);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 1, 0, AF_NETLINK);
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO | EPERM);
  emit(filter, &n, BPF_LD | BPF_W | BPF_ABS, 0, 0, arg2);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 13, 0, NETLINK_ROUTE);
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO | EPERM);
  emit(filter, &n, BPF_LD | BPF_W | BPF_ABS, 0, 0, arg1);
  emit(filter, &n, BPF_ALU | BPF_AND | BPF_K, 0, 0, ~(__u32)(SOCK_NONBLOCK | SOCK_CLOEXEC));
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 2, 0, SOCK_STREAM);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 1, 0, SOCK_DGRAM);
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO | EPERM);
  emit(filter, &n, BPF_LD | BPF_W | BPF_ABS, 0, 0, arg2);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 5, 0, IPPROTO_IP);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 4, 0, IPPROTO_ICMP);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 3, 0, IPPROTO_TCP);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 2, 0, IPPROTO_UDP);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 1, 0, IPPROTO_ICMPV6);
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO | EPERM);
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW);
  /* socketpair: 7 instructions. A miss skips the 6 after the compare. */
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 0, 6, table->socketpair_nr);
  emit(filter, &n, BPF_LD | BPF_W | BPF_ABS, 0, 0, arg1);
  emit(filter, &n, BPF_ALU | BPF_AND | BPF_K, 0, 0, ~(__u32)(SOCK_NONBLOCK | SOCK_CLOEXEC));
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 2, 0, SOCK_STREAM);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 1, 0, SOCK_SEQPACKET);
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO | EPERM);
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW);
  /* MSG_FASTOPEN on sendto (arg3), sendmmsg (arg3) or sendmsg (arg2): 9 instructions.
   * A miss of all three skips the 6 after the sendmsg compare.
   *   jeq sendto, +4
   *   jeq sendmmsg, +3
   *   jeq sendmsg, 0, +6
   *   ld arg2
   *   ja +1
   *   ld arg3
   *   jset MSG_FASTOPEN, 0, +1
   *   ret EPERM
   *   ret ALLOW
   */
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 4, 0, table->sendto_nr);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 3, 0, table->sendmmsg_nr);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 0, 6, table->sendmsg_nr);
  emit(filter, &n, BPF_LD | BPF_W | BPF_ABS, 0, 0, arg2);
  emit(filter, &n, BPF_JMP | BPF_JA | BPF_K, 0, 0, 1);
  emit(filter, &n, BPF_LD | BPF_W | BPF_ABS, 0, 0, arg3);
  emit(filter, &n, BPF_JMP | BPF_JSET | BPF_K, 0, 1, MSG_FASTOPEN);
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO | EPERM);
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW);
  /*
   * Scheduling, priority, io priority and prlimit. Each block returns, so a miss leaves the
   * syscall number in A. The filter is inherited and cannot call getpid(), so "this task" is
   * pid/who 0: the kernel reads that as the caller. Any other id (the helper, the runner, or
   * another process of this uid) is EPERM. Landlock scopes signals, not these calls.
   *
   * setpriority: which must be PRIO_PROCESS (0) and who must be 0. PRIO_PGRP or PRIO_USER would
   * renice a group or every process of a uid.
   *   jeq nr, 0, +6 / ld which / jeq PRIO_PROCESS, 0, +3 / ld who / jeq 0, 0, +1 / ALLOW / EPERM
   * sched_setscheduler, sched_setparam, sched_setattr, sched_setaffinity: pid is arg0.
   *   four jeq share one "arg0 == 0" check.
   * prlimit64: pid is arg0. glibc getrlimit/setrlimit pass 0.
   * ioprio_set: which must be IOPRIO_WHO_PROCESS (1) and who must be 0. who 0 alone would also
   * match IOPRIO_WHO_USER (uid 0) and IOPRIO_WHO_PGRP (the caller's group, which can include
   * the helper).
   */
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 0, 6, table->setpriority_nr);
  emit(filter, &n, BPF_LD | BPF_W | BPF_ABS, 0, 0, arg0);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 0, 3, 0); /* PRIO_PROCESS */
  emit(filter, &n, BPF_LD | BPF_W | BPF_ABS, 0, 0, arg1);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0);
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW);
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO | EPERM);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 3, 0, table->sched_setscheduler_nr);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 2, 0, table->sched_setparam_nr);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 1, 0, table->sched_setattr_nr);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 0, 4, table->sched_setaffinity_nr);
  emit(filter, &n, BPF_LD | BPF_W | BPF_ABS, 0, 0, arg0);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0);
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW);
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO | EPERM);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 0, 4, table->prlimit64_nr);
  emit(filter, &n, BPF_LD | BPF_W | BPF_ABS, 0, 0, arg0);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0);
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW);
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO | EPERM);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 0, 6, table->ioprio_set_nr);
  emit(filter, &n, BPF_LD | BPF_W | BPF_ABS, 0, 0, arg0);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 0, 3, 1); /* IOPRIO_WHO_PROCESS */
  emit(filter, &n, BPF_LD | BPF_W | BPF_ABS, 0, 0, arg1);
  emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0);
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW);
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO | EPERM);
  for (unsigned i = 0; i < sizeof table->deny / sizeof table->deny[0]; i++) {
    emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 0, 1, table->deny[i]);
    emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO | EPERM);
  }
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW);

  struct sock_fprog prog = {.len = (unsigned short)n, .filter = filter};
  if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog) != 0)
    failf("seccomp: %s", strerror(errno));
}

/* Append the pids listed in one `children` file to *pids. Returns 0, or -1 on failure. */
static int read_children_file(const char *path, pid_t **pids, size_t *len, size_t *cap) {
  FILE *file = fopen(path, "r");
  if (file == NULL) return errno == ENOENT || errno == ESRCH ? 0 : -1;
  long value;
  while (fscanf(file, "%ld", &value) == 1) {
    if (value <= 1 || value == getpid()) continue;
    if (*len == *cap) {
      size_t next_cap = *cap == 0 ? 8 : *cap * 2;
      pid_t *next = realloc(*pids, next_cap * sizeof **pids);
      if (next == NULL) {
        fclose(file);
        return -1;
      }
      *pids = next;
      *cap = next_cap;
    }
    (*pids)[(*len)++] = (pid_t)value;
  }
  int failed = ferror(file);
  if (fclose(file) != 0) failed = 1;
  return failed ? -1 : 0;
}

/* Children of every thread of `parent`: fork() from a non-main thread lists the child there. */
static int process_children(pid_t parent, pid_t **out) {
  char path[128];
  snprintf(path, sizeof path, "/proc/%ld/task", (long)parent);
  DIR *dir = opendir(path);
  if (dir == NULL) return -1;
  pid_t *pids = NULL;
  size_t len = 0, cap = 0;
  int failed = 0;
  struct dirent *entry;
  while (!failed && (entry = readdir(dir)) != NULL) {
    if (entry->d_name[0] < '0' || entry->d_name[0] > '9') continue;
    char file[320];
    snprintf(file, sizeof file, "/proc/%ld/task/%s/children", (long)parent, entry->d_name);
    if (read_children_file(file, &pids, &len, &cap) != 0) failed = 1;
  }
  closedir(dir);
  if (failed) {
    free(pids);
    return -1;
  }
  *out = pids;
  return (int)len;
}

/*
 * Stop `pid` first, then walk its children, then deliver `sig`. A process cannot fork while it
 * is stopped, so a parent stops refilling its subtree before the walk reads the children list.
 * (Reading the children first lets a storm keep forking behind the walk.)
 */
static void signal_process_tree(pid_t pid, int sig) {
  (void)kill(pid, SIGSTOP);
  pid_t *children = NULL;
  int count = process_children(pid, &children);
  if (count > 0) {
    for (int i = 0; i < count; i++) signal_process_tree(children[i], sig);
  }
  free(children);
  if (sig != SIGSTOP) (void)kill(pid, sig);
}

/* PR_SET_CHILD_SUBREAPER makes orphaned setsid/double-fork descendants our children. */
static void kill_and_reap_descendants(void) {
  for (;;) {
    pid_t *children = NULL;
    int count = process_children(getpid(), &children);
    if (count < 0) {
      free(children);
      /* Keep the helper alive if procfs cannot enumerate the sandbox. */
      struct timespec delay = {.tv_sec = 0, .tv_nsec = 10000000};
      nanosleep(&delay, NULL);
      continue;
    }
    if (count == 0) {
      free(children);
      while (waitpid(-1, NULL, WNOHANG) > 0) {}
      return;
    }
    // signal_process_tree stops each process before it reads that process's children, then
    // kills it. Repeat until there are no descendants.
    for (int i = 0; i < count; i++) signal_process_tree(children[i], SIGKILL);
    free(children);
    while (waitpid(-1, NULL, WNOHANG) > 0) {}
    struct timespec delay = {.tv_sec = 0, .tv_nsec = 10000000};
    nanosleep(&delay, NULL);
  }
}

/*
 * RLIMIT_NPROC is checked against the forking task's limit and counts every task (threads
 * included) of that real uid, sandboxed or not. It does not count other users or kernel threads.
 * The cap is fixed when the helper starts, and every sandbox of this uid shares the uid's count,
 * so the headroom has to leave room for a JVM, gradle, a large -j build and a sibling helper.
 *
 * Floor is the smallest cap even when the uid is quiet. Headroom is how many more tasks this
 * sandbox may create on top of the uid's current tasks. The cap is the greater of the two:
 * max(floor, uid tasks + headroom). It never grows with the host's task count. Both default to
 * 8192, which is deliberately loose: the symptom of a tight cap is a bare EAGAIN in a long step.
 * The cap only lowers the caller's current limit; it cannot raise a hard limit.
 *
 * BOOF_SANDBOX_NPROC_FLOOR and BOOF_SANDBOX_NPROC_HEADROOM override the defaults. The runner
 * copies those from the server process after it has dropped every BOOF_SANDBOX_* name the agent
 * environment tried to set. The helper unsets both before exec, so the command never sees them.
 */
#define SANDBOX_NPROC_FLOOR 8192UL
#define SANDBOX_NPROC_HEADROOM 8192UL
#define SANDBOX_NPROC_OVERRIDE_MAX 1000000UL

/*
 * One scan of /proc. A process that exits mid-scan (ESRCH/ENOENT on its status) is skipped,
 * unless it is the helper's own pid. 0 on failure.
 */
static unsigned long caller_task_count_once(void) {
#ifdef BOOF_SANDBOX_TEST
  static int race_injected = 0;
#endif
  DIR *dir = opendir("/proc");
  if (dir == NULL) return 0;
  uid_t uid = getuid();
  char self_name[32];
  snprintf(self_name, sizeof self_name, "%ld", (long)getpid());
  unsigned long total = 0;
  int saw_self = 0;
  int failed = 0;
  for (;;) {
    errno = 0;
    struct dirent *ent = readdir(dir);
    if (ent == NULL) {
      if (errno != 0) failed = 1;
      break;
    }
    const char *name = ent->d_name;
    if (name[0] < '1' || name[0] > '9') continue;
    int numeric = 1;
    for (const char *p = name; *p != '\0'; p++) {
      if (*p < '0' || *p > '9') numeric = 0;
    }
    if (!numeric) continue;
    char path[64];
    if (snprintf(path, sizeof path, "/proc/%s/status", name) >= (int)sizeof path) continue;
    FILE *file = fopen(path, "r");
    if (file == NULL) {
      if (errno == ENOENT || errno == ESRCH || errno == EACCES) continue;
      failed = 1;
      break;
    }
    char line[512];
    int match = 0;
    int saw_threads = 0;
    unsigned long threads = 0;
    unsigned long real_uid = 0;
    while (fgets(line, sizeof line, file) != NULL) {
      if (strncmp(line, "Uid:", 4) == 0) {
        if (sscanf(line, "Uid: %lu", &real_uid) == 1) match = real_uid == (unsigned long)uid;
      } else if (strncmp(line, "Threads:", 8) == 0) {
        if (sscanf(line, "Threads: %lu", &threads) == 1) saw_threads = 1;
      }
    }
    int bad = ferror(file);
    int read_errno = errno;
    fclose(file);
    int is_self = strcmp(name, self_name) == 0;
#ifdef BOOF_SANDBOX_TEST
    if (!is_self && !race_injected && sandbox_fault("proc-race")) {
      race_injected = 1;
      bad = 1;
      read_errno = ESRCH;
    }
#endif
    if (bad) {
      if (!is_self && (read_errno == ESRCH || read_errno == ENOENT)) continue;
      failed = 1;
      break;
    }
    if (match) {
      if (!saw_threads || threads == 0) {
        failed = 1;
        break;
      }
      total += threads;
    }
    if (is_self) {
      if (!match || !saw_threads) failed = 1;
      else saw_self = 1;
    }
  }
  closedir(dir);
  if (failed || !saw_self || total == 0) return 0;
  return total;
}

/* Sum of Threads: for the caller's uid. The scan is retried once if it was inconsistent. */
static unsigned long caller_task_count(void) {
#ifdef BOOF_SANDBOX_TEST
  if (sandbox_fault("proc-tasks")) return 0;
#endif
  unsigned long total = caller_task_count_once();
  if (total == 0) total = caller_task_count_once();
  return total;
}

static unsigned long nproc_knob(const char *name, unsigned long fallback) {
  const char *text = getenv(name);
  if (text == NULL || text[0] == '\0') return fallback;
  if (text[0] < '0' || text[0] > '9') failf("bad %s", name);
  errno = 0;
  char *end = NULL;
  unsigned long value = strtoul(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value > SANDBOX_NPROC_OVERRIDE_MAX)
    failf("bad %s", name);
  return value;
}

/*
 * Applied in the sandboxed child before exec. The nproc cap bounds a fork storm. nice 19 lets
 * the supervisor win the CPU when it has to stop and kill one. RLIMIT_NICE and RLIMIT_RTPRIO
 * hard 0 then stop the command raising its priority or going real-time on a host that granted it.
 */
static void apply_resource_limits(void) {
  unsigned long tasks = caller_task_count();
  if (tasks == 0) failf("cannot count caller tasks: proc status unavailable");
  unsigned long floor = nproc_knob("BOOF_SANDBOX_NPROC_FLOOR", SANDBOX_NPROC_FLOOR);
  unsigned long headroom = nproc_knob("BOOF_SANDBOX_NPROC_HEADROOM", SANDBOX_NPROC_HEADROOM);
  unsetenv("BOOF_SANDBOX_NPROC_FLOOR");
  unsetenv("BOOF_SANDBOX_NPROC_HEADROOM");
  if (headroom > ~(unsigned long)0 - tasks) failf("cannot count caller tasks: overflow");
  unsigned long sum = tasks + headroom;
  unsigned long cap_ul = sum > floor ? sum : floor;
  struct rlimit nproc;
#ifdef BOOF_SANDBOX_TEST
  if (sandbox_fault("getrlimit")) failf("getrlimit nproc: test fault");
#endif
  if (getrlimit(RLIMIT_NPROC, &nproc) != 0) failf("getrlimit nproc: %s", strerror(errno));
  rlim_t cap = (rlim_t)cap_ul;
  if (cap < nproc.rlim_max) nproc.rlim_max = cap;
  if (cap < nproc.rlim_cur) nproc.rlim_cur = cap;
  if (setrlimit(RLIMIT_NPROC, &nproc) != 0) failf("setrlimit nproc: %s", strerror(errno));
  if (setpriority(PRIO_PROCESS, 0, 19) != 0) failf("setpriority: %s", strerror(errno));
  struct rlimit nice_lim;
  if (getrlimit(RLIMIT_NICE, &nice_lim) != 0) failf("getrlimit nice: %s", strerror(errno));
  /* 20 - rlim is the best nice allowed. 0 means the command cannot raise its priority. */
  nice_lim.rlim_cur = 0;
  nice_lim.rlim_max = 0;
  if (setrlimit(RLIMIT_NICE, &nice_lim) != 0) failf("setrlimit nice: %s", strerror(errno));
  /* No real-time scheduling either: a SCHED_FIFO command would starve the nice 19 supervisor. */
  struct rlimit rt_lim = {0, 0};
  if (setrlimit(RLIMIT_RTPRIO, &rt_lim) != 0) failf("setrlimit rtprio: %s", strerror(errno));
}

/* CONFIG_PROC_CHILDREN is required. ENOENT here used to look like "no children". */
static void require_proc_children(void) {
#ifdef BOOF_SANDBOX_TEST
  if (sandbox_fault("proc-children")) failf("proc children unavailable: ENOENT");
#endif
  long tid = syscall(SYS_gettid);
  char path[128];
  snprintf(path, sizeof path, "/proc/self/task/%ld/children", tid);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) failf("proc children unavailable: %s", strerror(errno));
  close(fd);
}

static volatile sig_atomic_t supervisor_signal = 0;

static void note_supervisor_signal(int sig) { supervisor_signal = sig; }

static int policy_fd_arg(const char *text) {
  if (text == NULL || text[0] < '1' || text[0] > '9') return -1;
  char *end = NULL;
  errno = 0;
  long value = strtol(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value < 3 || value > 0x7fffffffL) return -1;
  return (int)value;
}

static char *read_policy(int fd, size_t *len_out) {
  size_t cap = 4096;
  size_t len = 0;
  char *buf = malloc(cap);
  if (!buf) fail("out of memory");
  policy_buf = buf;
  for (;;) {
    if (len == cap) {
      if (cap > MAX_POLICY / 2) fail("policy is too large");
      cap *= 2;
      char *next = realloc(buf, cap);
      if (!next) fail("out of memory");
      buf = next;
      policy_buf = buf;
    }
    ssize_t n = read(fd, buf + len, cap - len);
    if (n == 0) break;
    if (n < 0) {
      if (errno == EINTR) continue;
      failf("cannot read policy: %s", strerror(errno));
    }
    len += (size_t)n;
    if (len > MAX_POLICY) fail("policy is too large");
  }
  *len_out = len;
  return buf;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--abi") == 0) {
    printf("%d\n", landlock_abi());
    return 0;
  }
  if (argc < 5 || strcmp(argv[1], "--policy-fd") != 0 || strcmp(argv[3], "--") != 0)
    fail("bad arguments");
  int abi = landlock_abi();
  if (abi < 6)
    failf("Landlock ABI %d does not scope signals; upgrade the kernel to 6.12 or newer (ABI 6) before enforcing", abi);
  struct rlimit nofile;
  if (getrlimit(RLIMIT_NOFILE, &nofile) != 0) failf("getrlimit: %s", strerror(errno));
  if (nofile.rlim_max > 4096) nofile.rlim_max = 4096;
  if (nofile.rlim_cur > nofile.rlim_max) nofile.rlim_cur = nofile.rlim_max;
  if (setrlimit(RLIMIT_NOFILE, &nofile) != 0) failf("setrlimit: %s", strerror(errno));
  int fd = policy_fd_arg(argv[2]);
  if (fd < 0 || fcntl(fd, F_GETFD) < 0) fail("bad arguments");
  int flags = fcntl(fd, F_GETFD);
  if (flags < 0 || fcntl(fd, F_SETFD, flags | FD_CLOEXEC) != 0) fail("cannot read policy");

  size_t len = 0;
  char *buf = read_policy(fd, &len);
  close(fd);
  parse_policy(buf, len);

  require_proc_children();
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0)
    failf("child subreaper: %s", strerror(errno));
  struct sigaction action;
  memset(&action, 0, sizeof action);
  action.sa_handler = note_supervisor_signal;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) != 0 || sigaction(SIGINT, &action, NULL) != 0 ||
      sigaction(SIGHUP, &action, NULL) != 0)
    failf("signal handlers: %s", strerror(errno));

  pid_t child = fork();
  if (child < 0) failf("fork: %s", strerror(errno));
  if (child == 0) {
    struct sigaction def;
    memset(&def, 0, sizeof def);
    def.sa_handler = SIG_DFL;
    sigemptyset(&def.sa_mask);
    sigaction(SIGTERM, &def, NULL);
    sigaction(SIGINT, &def, NULL);
    sigaction(SIGHUP, &def, NULL);
    apply_resource_limits();
    apply_landlock(abi);
    apply_seccomp();
    free(policy_buf);
    policy_buf = NULL;
    free(arena);
    arena = NULL;
    execvp(argv[4], &argv[4]);
    failf("exec %s: %s", argv[4], strerror(errno));
  }
  /*
   * The helper is a subreaper, so orphans it did not spawn become its children. Reap every
   * zombie while the command runs. A zombie still counts toward RLIMIT_NPROC. Only the direct
   * child's status is the command's status; an orphan's status is discarded.
   */
  int status = 0;
  int child_done = 0;
  for (;;) {
    int st = 0;
    pid_t waited;
    while ((waited = waitpid(-1, &st, WNOHANG)) > 0) {
      if (waited == child) {
        status = st;
        child_done = 1;
      }
    }
    if (child_done) break;
    if (waited < 0 && errno != EINTR) failf("waitpid: %s", strerror(errno));
    if (supervisor_signal) signal_process_tree(child, SIGKILL);
    struct timespec delay = {.tv_sec = 0, .tv_nsec = 10000000};
    nanosleep(&delay, NULL);
  }
  kill_and_reap_descendants();
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 126;
}
