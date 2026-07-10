#!/bin/sh
# Derives V8's max-old-space-size from the container's memory limit so the
# heap can use the task's actual allocation instead of Node's ~2GB default.
# Detection order: cgroup v2, cgroup v1, /proc/meminfo (Fargate microVMs
# report task memory as MemTotal). The heap gets 80% of the limit or the
# limit minus 384MiB of fixed headroom, whichever is smaller, so small tasks
# keep room for chromium renders and other native memory instead of trading
# heap OOMs for container OOM-kills. The flag is passed as a CLI arg to the
# server process only — NOT exported — so child Node processes (SDK
# subprocesses, md-to-pdf) keep their own defaults. An explicit
# max-old-space-size in NODE_OPTIONS always wins over the derived value.
set -eu

detect_memory_limit_bytes() {
  if [ -r /sys/fs/cgroup/memory.max ]; then
    limit=$(cat /sys/fs/cgroup/memory.max)
    if [ "$limit" != "max" ] && [ "$limit" -gt 0 ] 2>/dev/null; then
      echo "$limit"
      return 0
    fi
  fi
  if [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
    limit=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)
    if [ "$limit" -gt 0 ] 2>/dev/null && [ "$limit" -lt 4611686018427387904 ]; then
      echo "$limit"
      return 0
    fi
  fi
  if [ -r /proc/meminfo ]; then
    mem_total_kib=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
    if [ -n "$mem_total_kib" ] && [ "$mem_total_kib" -gt 0 ] 2>/dev/null; then
      echo $((mem_total_kib * 1024))
      return 0
    fi
  fi
  return 1
}

heap_arg=""
case " ${NODE_OPTIONS:-} " in
  *" --max-old-space-size"* | *" --max_old_space_size"*) ;;
  *)
    if limit_bytes=$(detect_memory_limit_bytes); then
      limit_mib=$((limit_bytes / 1048576))
      heap_mib=$((limit_mib * 80 / 100))
      headroom_mib=$((limit_mib - 384))
      if [ "$headroom_mib" -lt "$heap_mib" ]; then
        heap_mib=$headroom_mib
      fi
      if [ "$heap_mib" -ge 256 ]; then
        heap_arg="--max-old-space-size=${heap_mib}"
        echo "{\"msg\":\"Derived Node heap cap from container memory\",\"limitMib\":${limit_mib},\"maxOldSpaceMib\":${heap_mib}}"
      fi
    fi
    ;;
esac

exec node ${heap_arg:+"$heap_arg"} dist/index.js "$@"
