#!/bin/sh
set -e

# Derive V8 old-space cap from the container's memory limit.
# Skipped if the caller already pinned a heap size via NODE_OPTIONS (manual override wins).
# Tune the fraction of the limit handed to V8 via HEAP_PERCENT.
if ! printf '%s' "${NODE_OPTIONS:-}" | grep -q 'max-old-space-size'; then
  limit_bytes=""
  if [ -r /sys/fs/cgroup/memory.max ]; then                    # cgroup v2
    v=$(cat /sys/fs/cgroup/memory.max)
    [ "$v" != "max" ] && limit_bytes="$v"
  elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then # cgroup v1
    limit_bytes=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)
  fi

  if [ -n "$limit_bytes" ] && [ "$limit_bytes" -gt 0 ] 2>/dev/null; then
    limit_mb=$((limit_bytes / 1024 / 1024))
    # Ignore the cgroup "unlimited" sentinel (a very large number).
    if [ "$limit_mb" -gt 0 ] && [ "$limit_mb" -lt 1048576 ]; then
      pct="${HEAP_PERCENT:-75}"
      heap_mb=$((limit_mb * pct / 100))
      export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=${heap_mb}"
      echo "docker-entrypoint: container memory limit ${limit_mb}MB -> --max-old-space-size=${heap_mb} (${pct}%)"
    fi
  fi
fi

# Cap glibc malloc arenas. Heavy allocation churn during math/HTML rendering otherwise
# lets glibc retain many per-thread arenas (up to 8 * nCPU), inflating RSS well beyond the
# live heap — a classic "high RSS, low heap" container OOM. Left overridable from the task def.
export MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}"

exec node build/workers/processor.mjs
