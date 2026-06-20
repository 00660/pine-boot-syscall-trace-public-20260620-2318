#define _GNU_SOURCE

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#define CHUNK_SIZE (1024 * 1024)
#define SCAN_OVERLAP 16
#define DEFAULT_SECONDS 45
#define MAX_DEX_BYTES (128U * 1024U * 1024U)
#define MAX_SEEN 4096
#define MAX_PIDS 256

typedef struct {
    uint32_t checksum;
    uint32_t file_size;
    uint8_t signature[20];
} dex_key_t;

typedef struct {
    unsigned long start;
    unsigned long end;
    char perms[5];
    char name[PATH_MAX];
} map_entry_t;

static dex_key_t seen[MAX_SEEN];
static size_t seen_count;
static FILE *log_file;

static void log_line(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vfprintf(stdout, fmt, args);
    fputc('\n', stdout);
    va_end(args);

    if (log_file) {
        va_start(args, fmt);
        vfprintf(log_file, fmt, args);
        fputc('\n', log_file);
        fflush(log_file);
        va_end(args);
    }
}

static uint32_t read_u32_le(const uint8_t *buf) {
    return ((uint32_t)buf[0]) |
           ((uint32_t)buf[1] << 8) |
           ((uint32_t)buf[2] << 16) |
           ((uint32_t)buf[3] << 24);
}

static bool valid_dex_header(const uint8_t *buf, size_t available, uint32_t *file_size, uint32_t *checksum) {
    if (available < 0x70) return false;
    if (memcmp(buf, "dex\n", 4) != 0) return false;
    if (!isdigit(buf[4]) || !isdigit(buf[5]) || !isdigit(buf[6]) || buf[7] != 0) return false;

    uint32_t size = read_u32_le(buf + 0x20);
    uint32_t header_size = read_u32_le(buf + 0x24);
    uint32_t endian_tag = read_u32_le(buf + 0x28);
    if ((header_size != 0x70 && header_size != 0x78) || endian_tag != 0x12345678) return false;
    if (size < header_size || size > MAX_DEX_BYTES) return false;

    *file_size = size;
    *checksum = read_u32_le(buf + 8);
    return true;
}

static bool already_seen(const uint8_t *header, uint32_t file_size, uint32_t checksum) {
    for (size_t i = 0; i < seen_count; i++) {
        if (seen[i].checksum == checksum &&
            seen[i].file_size == file_size &&
            memcmp(seen[i].signature, header + 12, 20) == 0) {
            return true;
        }
    }
    if (seen_count < MAX_SEEN) {
        seen[seen_count].checksum = checksum;
        seen[seen_count].file_size = file_size;
        memcpy(seen[seen_count].signature, header + 12, 20);
        seen_count++;
    }
    return false;
}

static ssize_t read_remote(pid_t pid, unsigned long remote_addr, void *buf, size_t len) {
    struct iovec local_iov = { .iov_base = buf, .iov_len = len };
    struct iovec remote_iov = { .iov_base = (void *)remote_addr, .iov_len = len };
    ssize_t n = process_vm_readv(pid, &local_iov, 1, &remote_iov, 1, 0);
    if (n >= 0) return n;

    char mem_path[64];
    snprintf(mem_path, sizeof(mem_path), "/proc/%d/mem", pid);
    int fd = open(mem_path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    n = pread(fd, buf, len, (off_t)remote_addr);
    close(fd);
    return n;
}

static bool read_full_remote(pid_t pid, unsigned long addr, int out_fd, size_t len) {
    uint8_t *buf = malloc(CHUNK_SIZE);
    if (!buf) return false;

    size_t done = 0;
    while (done < len) {
        size_t want = len - done;
        if (want > CHUNK_SIZE) want = CHUNK_SIZE;
        ssize_t got = read_remote(pid, addr + done, buf, want);
        if (got <= 0) {
            free(buf);
            return false;
        }
        if (write(out_fd, buf, (size_t)got) != got) {
            free(buf);
            return false;
        }
        done += (size_t)got;
    }

    free(buf);
    return true;
}

static bool attach_pid(pid_t pid) {
    if (ptrace(PTRACE_ATTACH, pid, NULL, NULL) != 0) {
        log_line("pid=%d attach failed: %s", pid, strerror(errno));
        return false;
    }
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        log_line("pid=%d wait after attach failed: %s", pid, strerror(errno));
        ptrace(PTRACE_DETACH, pid, NULL, NULL);
        return false;
    }
    return true;
}

static void detach_pid(pid_t pid) {
    if (ptrace(PTRACE_DETACH, pid, NULL, NULL) != 0) {
        log_line("pid=%d detach failed: %s", pid, strerror(errno));
    }
}

static bool parse_map_line(const char *line, map_entry_t *entry) {
    memset(entry, 0, sizeof(*entry));
    unsigned long offset = 0;
    char dev[32] = {0};
    unsigned long inode = 0;
    int matched = sscanf(line, "%lx-%lx %4s %lx %31s %lu %4095[^\n]",
                         &entry->start, &entry->end, entry->perms,
                         &offset, dev, &inode, entry->name);
    return matched >= 6 && entry->end > entry->start;
}

static bool should_scan_map(const map_entry_t *entry) {
    if (entry->perms[0] != 'r') return false;
    if (entry->end <= entry->start) return false;
    unsigned long size = entry->end - entry->start;
    if (size < 0x70) return false;
    if (strstr(entry->name, "/dev/ashmem/dalvik-") != NULL) return true;
    if (strstr(entry->name, "classes") != NULL) return true;
    if (strstr(entry->name, ".apk") != NULL) return true;
    if (strstr(entry->name, ".dex") != NULL) return true;
    if (strstr(entry->name, "[anon:") != NULL) return true;
    if (entry->name[0] == '\0') return true;
    return size <= (64UL * 1024UL * 1024UL);
}

static int dump_dex(pid_t pid, unsigned long addr, const uint8_t *header, uint32_t file_size,
                    uint32_t checksum, const char *out_dir, int *dump_index) {
    char out_path[PATH_MAX];
    snprintf(out_path, sizeof(out_path), "%s/pid%d_%04d_%lx_%u_%08x.dex",
             out_dir, pid, *dump_index, addr, file_size, checksum);
    int fd = open(out_path, O_CREAT | O_WRONLY | O_TRUNC | O_CLOEXEC, 0644);
    if (fd < 0) {
        log_line("pid=%d addr=0x%lx create failed: %s", pid, addr, strerror(errno));
        return 0;
    }
    bool ok = read_full_remote(pid, addr, fd, file_size);
    close(fd);
    if (!ok) {
        unlink(out_path);
        log_line("pid=%d addr=0x%lx read full dex failed size=%u", pid, addr, file_size);
        return 0;
    }
    log_line("dumped %s size=%u checksum=%08x magic=%.7s", out_path, file_size, checksum, header);
    (*dump_index)++;
    return 1;
}

static int scan_map(pid_t pid, const map_entry_t *entry, const char *out_dir, int *dump_index) {
    uint8_t *buf = malloc(CHUNK_SIZE + SCAN_OVERLAP);
    if (!buf) return 0;

    int dumped = 0;
    unsigned long pos = entry->start;
    size_t carry = 0;
    while (pos < entry->end) {
        size_t want = entry->end - pos;
        if (want > CHUNK_SIZE) want = CHUNK_SIZE;
        ssize_t got = read_remote(pid, pos, buf + carry, want);
        if (got <= 0) break;

        size_t total = carry + (size_t)got;
        for (size_t i = 0; i + 0x70 <= total; i++) {
            uint32_t file_size = 0;
            uint32_t checksum = 0;
            if (!valid_dex_header(buf + i, total - i, &file_size, &checksum)) continue;
            unsigned long dex_addr = pos - carry + i;
            if (already_seen(buf + i, file_size, checksum)) continue;
            dumped += dump_dex(pid, dex_addr, buf + i, file_size, checksum, out_dir, dump_index);
        }

        carry = total < SCAN_OVERLAP ? total : SCAN_OVERLAP;
        memmove(buf, buf + total - carry, carry);
        pos += (unsigned long)got;
    }

    free(buf);
    return dumped;
}

static int scan_pid(pid_t pid, const char *out_dir, int *dump_index) {
    if (!attach_pid(pid)) {
        return 0;
    }

    char maps_path[64];
    snprintf(maps_path, sizeof(maps_path), "/proc/%d/maps", pid);
    FILE *maps = fopen(maps_path, "re");
    if (!maps) {
        log_line("pid=%d open maps failed: %s", pid, strerror(errno));
        detach_pid(pid);
        return 0;
    }

    int dumped = 0;
    char line[8192];
    while (fgets(line, sizeof(line), maps)) {
        map_entry_t entry;
        if (!parse_map_line(line, &entry) || !should_scan_map(&entry)) continue;
        dumped += scan_map(pid, &entry, out_dir, dump_index);
    }

    detach_pid(pid);
    fclose(maps);
    return dumped;
}

static bool pid_matches_package(pid_t pid, const char *package_name) {
    char path[64];
    snprintf(path, sizeof(path), "/proc/%d/cmdline", pid);
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return false;
    char cmdline[512];
    ssize_t n = read(fd, cmdline, sizeof(cmdline) - 1);
    close(fd);
    if (n <= 0) return false;
    cmdline[n] = '\0';
    size_t package_len = strlen(package_name);
    return strncmp(cmdline, package_name, package_len) == 0 &&
           (cmdline[package_len] == '\0' || cmdline[package_len] == ':');
}

static int find_pids(const char *package_name, pid_t *pids, int max_pids) {
    DIR *proc = opendir("/proc");
    if (!proc) return 0;
    int count = 0;
    struct dirent *de;
    while ((de = readdir(proc)) != NULL && count < max_pids) {
        char *end = NULL;
        long value = strtol(de->d_name, &end, 10);
        if (!end || *end != '\0' || value <= 0) continue;
        pid_t pid = (pid_t)value;
        if (pid_matches_package(pid, package_name)) {
            pids[count++] = pid;
        }
    }
    closedir(proc);
    return count;
}

static void usage(const char *argv0) {
    fprintf(stderr, "usage: %s --package <package> --out <dir> [--seconds N]\n", argv0);
}

int main(int argc, char **argv) {
    const char *package_name = NULL;
    const char *out_dir = NULL;
    int seconds = DEFAULT_SECONDS;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--package") == 0 && i + 1 < argc) {
            package_name = argv[++i];
        } else if (strcmp(argv[i], "--out") == 0 && i + 1 < argc) {
            out_dir = argv[++i];
        } else if (strcmp(argv[i], "--seconds") == 0 && i + 1 < argc) {
            seconds = atoi(argv[++i]);
            if (seconds <= 0) seconds = DEFAULT_SECONDS;
        } else {
            usage(argv[0]);
            return 2;
        }
    }

    if (!package_name || !out_dir) {
        usage(argv[0]);
        return 2;
    }

    if (mkdir(out_dir, 0755) != 0 && errno != EEXIST) {
        fprintf(stderr, "mkdir %s failed: %s\n", out_dir, strerror(errno));
        return 1;
    }

    char log_path[PATH_MAX];
    snprintf(log_path, sizeof(log_path), "%s/pine-art-dexdump.log", out_dir);
    log_file = fopen(log_path, "ae");

    log_line("pine-art-dexdump package=%s out=%s seconds=%d", package_name, out_dir, seconds);
    time_t deadline = time(NULL) + seconds;
    int total_dumped = 0;
    int dump_index = 0;

    do {
        pid_t pids[MAX_PIDS];
        int pid_count = find_pids(package_name, pids, MAX_PIDS);
        log_line("found %d pid(s) for %s", pid_count, package_name);
        for (int i = 0; i < pid_count; i++) {
            total_dumped += scan_pid(pids[i], out_dir, &dump_index);
        }
        if (total_dumped > 0) break;
        sleep(2);
    } while (time(NULL) < deadline);

    log_line("done dumped=%d unique=%zu", total_dumped, seen_count);
    if (log_file) fclose(log_file);
    return 0;
}
