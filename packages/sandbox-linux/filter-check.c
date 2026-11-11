#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/elf.h>
#include <linux/filter.h>
#include <linux/netlink.h>
#include <linux/seccomp.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

#define BOOF_FILTER_MAX 128

/*
 * Stops boof-sandbox at seccomp(SECCOMP_SET_MODE_FILTER) and checks the
 * installed program kills every audit architecture except the native Linux one.
 */

#if defined(__aarch64__)
#include <asm/ptrace.h>
#define BOOF_AUDIT_ARCH 0xC00000B7u
#define BOOF_SYS_seccomp 277
static int read_syscall(pid_t pid, unsigned long long *nr, unsigned long long *a0,
                        unsigned long long *a2) {
  struct user_pt_regs regs;
  struct iovec iov = {.iov_base = &regs, .iov_len = sizeof regs};
  if (ptrace(PTRACE_GETREGSET, pid, (void *)(uintptr_t)NT_PRSTATUS, &iov) != 0) return -1;
  *nr = regs.regs[8];
  *a0 = regs.regs[0];
  *a2 = regs.regs[2];
  return 0;
}
#elif defined(__x86_64__)
#include <sys/user.h>
#define BOOF_AUDIT_ARCH 0xC000003Eu
#define BOOF_SYS_seccomp 317
static int read_syscall(pid_t pid, unsigned long long *nr, unsigned long long *a0,
                        unsigned long long *a2) {
  struct user_regs_struct regs;
  if (ptrace(PTRACE_GETREGS, pid, NULL, &regs) != 0) return -1;
  *nr = (unsigned long long)regs.orig_rax;
  *a0 = (unsigned long long)regs.rdi;
  *a2 = (unsigned long long)regs.rdx;
  return 0;
}
#else
#error "filter-check supports x86_64 and aarch64 only"
#endif

static int read_remote(pid_t pid, unsigned long long addr, void *buf, size_t len) {
  struct iovec local = {.iov_base = buf, .iov_len = len};
  struct iovec remote = {.iov_base = (void *)(uintptr_t)addr, .iov_len = len};
  ssize_t n = process_vm_readv(pid, &local, 1, &remote, 1, 0);
  return n == (ssize_t)len ? 0 : -1;
}

#if defined(__aarch64__)
static const __u32 k_socket = 198;
static const __u32 k_socketpair = 199;
static const __u32 k_sendto = 206;
static const __u32 k_sendmsg = 211;
static const __u32 k_sendmmsg = 269;
static const __u32 k_deny[] = {425, 426, 427, 117, 270, 271, 40, 39, 41, 51, 268,
                               219, 217, 218, 280, 241, 282};
#elif defined(__x86_64__)
static const __u32 k_socket = 41;
static const __u32 k_socketpair = 53;
static const __u32 k_sendto = 44;
static const __u32 k_sendmsg = 46;
static const __u32 k_sendmmsg = 307;
static const __u32 k_deny[] = {425, 426, 427, 101, 310, 311, 165, 166, 155, 161, 308,
                               250, 248, 249, 321, 298, 323};
#endif

static int has_k(const struct sock_filter *filter, unsigned len, __u16 code, __u32 k) {
  for (unsigned i = 0; i < len; i++) {
    if (filter[i].code == code && filter[i].k == k) return 1;
  }
  return 0;
}

static int has_jeq(const struct sock_filter *filter, unsigned len, __u32 k) {
  return has_k(filter, len, BPF_JMP | BPF_JEQ | BPF_K, k);
}

static int filter_ok(const struct sock_filter *filter, unsigned len) {
  int saw_native = 0;
  int saw_kill = 0;
  int saw_arch_load = 0;
  int saw_eperm = 0;
  for (unsigned i = 0; i < len; i++) {
    const struct sock_filter *insn = &filter[i];
    if (insn->code == (BPF_LD | BPF_W | BPF_ABS) && insn->k == 4) saw_arch_load = 1;
    if (insn->code == (BPF_JMP | BPF_JEQ | BPF_K) && (insn->k & 0xC0000000u) == 0xC0000000u) {
      if (insn->k != BOOF_AUDIT_ARCH) return 0;
      saw_native = 1;
    }
    if (insn->code == (BPF_RET | BPF_K) && insn->k == SECCOMP_RET_KILL_PROCESS) saw_kill = 1;
    if (insn->code == (BPF_RET | BPF_K) && insn->k == (SECCOMP_RET_ERRNO | EPERM)) saw_eperm = 1;
  }
  if (!saw_arch_load || !saw_native || !saw_kill || !saw_eperm) return 0;
  if (!has_jeq(filter, len, k_socket) || !has_jeq(filter, len, k_socketpair) ||
      !has_jeq(filter, len, k_sendto) || !has_jeq(filter, len, k_sendmsg) ||
      !has_jeq(filter, len, k_sendmmsg))
    return 0;
  if (!has_jeq(filter, len, AF_INET) || !has_jeq(filter, len, AF_INET6) ||
      !has_jeq(filter, len, AF_NETLINK))
    return 0;
  if (!has_jeq(filter, len, IPPROTO_TCP) || !has_jeq(filter, len, IPPROTO_UDP) ||
      !has_jeq(filter, len, IPPROTO_ICMPV6) || !has_jeq(filter, len, NETLINK_ROUTE))
    return 0;
  if (!has_jeq(filter, len, SOCK_STREAM) || !has_jeq(filter, len, SOCK_SEQPACKET)) return 0;
  if (!has_k(filter, len, BPF_JMP | BPF_JSET | BPF_K, MSG_FASTOPEN)) return 0;
  if (!has_k(filter, len, BPF_ALU | BPF_AND | BPF_K, ~(__u32)(SOCK_NONBLOCK | SOCK_CLOEXEC)))
    return 0;
  for (unsigned i = 0; i < sizeof k_deny / sizeof k_deny[0]; i++) {
    if (!has_jeq(filter, len, k_deny[i])) return 0;
  }
#if defined(__x86_64__)
  int saw_x32 = 0;
  for (unsigned i = 0; i < len; i++) {
    if (filter[i].code == (BPF_JMP | BPF_JGE | BPF_K) && filter[i].k == 0x40000000u) saw_x32 = 1;
  }
  if (!saw_x32) return 0;
#endif
  return 1;
}

static void check_child(pid_t pid) {
  int status = 0;
  if (waitpid(pid, &status, 0) != pid) {
    fprintf(stderr, "filter-check: wait failed\n");
    exit(1);
  }
  if (ptrace(PTRACE_SETOPTIONS, pid, 0, PTRACE_O_TRACESYSGOOD) != 0) {
    fprintf(stderr, "filter-check: options failed\n");
    exit(1);
  }
  if (ptrace(PTRACE_SYSCALL, pid, 0, 0) != 0) {
    fprintf(stderr, "filter-check: syscall step failed\n");
    exit(1);
  }
  int entering = 1;
  for (;;) {
    if (waitpid(pid, &status, 0) != pid) break;
    if (WIFEXITED(status) || WIFSIGNALED(status)) break;
    if (!WIFSTOPPED(status)) break;
    int sig = WSTOPSIG(status);
    int pass = 0;
    if (sig == (SIGTRAP | 0x80)) {
      if (entering) {
        unsigned long long nr = 0, a0 = 0, a2 = 0;
        if (read_syscall(pid, &nr, &a0, &a2) == 0 && nr == BOOF_SYS_seccomp && a0 == SECCOMP_SET_MODE_FILTER) {
          struct sock_fprog prog;
          struct sock_filter filter[BOOF_FILTER_MAX];
          if (read_remote(pid, a2, &prog, sizeof prog) == 0 && prog.len > 0 &&
              prog.len <= BOOF_FILTER_MAX &&
              read_remote(pid, (unsigned long long)(uintptr_t)prog.filter, filter,
                          prog.len * sizeof filter[0]) == 0 &&
              filter_ok(filter, prog.len)) {
            printf("arch 0x%08x\n", BOOF_AUDIT_ARCH);
            fflush(stdout);
            kill(pid, SIGKILL);
            waitpid(pid, NULL, 0);
            exit(0);
          }
          fprintf(stderr, "filter-check: filter is not the native Linux arch check\n");
          kill(pid, SIGKILL);
          waitpid(pid, NULL, 0);
          exit(1);
        }
      }
      entering = !entering;
    } else if (sig != SIGTRAP && sig != SIGSTOP) {
      pass = sig;
    }
    if (ptrace(PTRACE_SYSCALL, pid, 0, pass) != 0) break;
  }
  fprintf(stderr, "filter-check: did not see the seccomp filter\n");
  kill(pid, SIGKILL);
  waitpid(pid, NULL, 0);
  exit(1);
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "filter-check: bad arguments\n");
    return 2;
  }
  char dir[] = "/tmp/boof-sandbox-filter-XXXXXX";
  if (!mkdtemp(dir)) {
    perror("mkdtemp");
    return 1;
  }
  char path[sizeof dir + 16];
  snprintf(path, sizeof path, "%s/policy.json", dir);
  FILE *file = fopen(path, "w");
  if (!file) {
    perror("fopen");
    return 1;
  }
  if (fputs("{\"version\":1,\"readExec\":[\"/usr\"],\"readWrite\":[\"/tmp\"],\"denyTcpPorts\":[1]}\n",
            file) < 0) {
    perror("fputs");
    return 1;
  }
  fclose(file);
  int policy = open(path, O_RDONLY);
  if (policy < 0) {
    perror("open");
    return 1;
  }
  pid_t pid = fork();
  if (pid < 0) {
    perror("fork");
    return 1;
  }
  if (pid == 0) {
    if (dup2(policy, 3) < 0) _exit(127);
    if (policy != 3) close(policy);
    if (ptrace(PTRACE_TRACEME, 0, 0, 0) != 0) _exit(127);
    raise(SIGSTOP);
    execl(argv[1], argv[1], "--policy-fd", "3", "--", "/bin/true", (char *)NULL);
    _exit(127);
  }
  close(policy);
  unlink(path);
  rmdir(dir);
  alarm(60);
  check_child(pid);
  return 1;
}
