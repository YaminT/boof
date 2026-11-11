#define _GNU_SOURCE

#include <ctype.h>
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
  __u32 deny[17];
};

/* Numbers from arch/x86/entry/syscalls/syscall_64.tbl and asm-generic/unistd.h.
 * x32 sendmsg/sendmmsg use different numbers, and the x32 bit kills them first.
 */
static const struct syscall_table k_tables[] = {
    {AUDIT_ARCH_X86_64, 0x40000000u, 41, 53, 44, 46, 307,
     {425, 426, 427, 101, 310, 311, 165, 166, 155, 161, 308, 250, 248, 249, 321, 298,
      323}},
    {AUDIT_ARCH_AARCH64, 0, 198, 199, 206, 211, 269,
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
  for (unsigned i = 0; i < sizeof table->deny / sizeof table->deny[0]; i++) {
    emit(filter, &n, BPF_JMP | BPF_JEQ | BPF_K, 0, 1, table->deny[i]);
    emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO | EPERM);
  }
  emit(filter, &n, BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW);

  struct sock_fprog prog = {.len = (unsigned short)n, .filter = filter};
  if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog) != 0)
    failf("seccomp: %s", strerror(errno));
}

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

  apply_landlock(landlock_abi());
  apply_seccomp();

  free(policy_buf);
  policy_buf = NULL;
  free(arena);
  arena = NULL;

  execvp(argv[4], &argv[4]);
  failf("exec %s: %s", argv[4], strerror(errno));
  return 126;
}
