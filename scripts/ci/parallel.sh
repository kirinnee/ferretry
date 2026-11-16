#!/usr/bin/env bash
set -euo pipefail

# Run every named part, at most <limit> at once, preserving each exit code and log even when a sibling fails.
# Usage: parallel.sh <directory> <limit> <command> [arguments...] -- <part>...
directory=$1
limit=$2
shift 2
[[ ${limit} =~ ^[1-9][0-9]*$ ]] || {
  echo "❌ parallel limit must be a positive integer" >&2
  exit 2
}
command=()
while [[ $# -gt 0 && $1 != -- ]]; do
  command+=("$1")
  shift
done
[[ $# -gt 1 && ${#command[@]} -gt 0 ]] || {
  echo "❌ parallel runner needs a command and parts" >&2
  exit 2
}
shift
parts=("$@")
mkdir -p "${directory}"
printf 'part\texit\tseconds\n' >"${directory}/results.tsv"
pids=()
status=0

# A POOL of at most <limit> parts: the next part starts the moment ANY running part ends, so one long part
# never holds back the others (fixed batches waited for the slowest of each batch: a 260 s unit group kept
# three free slots idle). Parts start in the order given, so list the longest first. Each part's exit code
# is read back from its own .tsv, which is written last; a part that wrote none failed.
run_part() {
  local part=$1 started=${SECONDS} part_status
  set +e
  "${command[@]}" "${part}" >"${directory}/${part}.log" 2>&1
  part_status=$?
  printf '%s\t%s\t%s\n' "${part}" "${part_status}" "$((SECONDS - started))" >"${directory}/${part}.tsv"
  exit "${part_status}"
}
for part in "${parts[@]}"; do
  rm -f "${directory}/${part}.tsv"
done
running=0
for part in "${parts[@]}"; do
  if [[ ${running} -ge ${limit} ]]; then
    wait -n || true
    running=$((running - 1))
  fi
  run_part "${part}" &
  pids+=("$!")
  running=$((running + 1))
done
for pid in "${pids[@]}"; do
  wait "${pid}" || true
done

printf '\n| Part | Exit | Duration |\n| --- | --- | --- |\n' >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
for part in "${parts[@]}"; do
  echo "📝 ${part} output"
  cat "${directory}/${part}.log" 2>/dev/null || true
  if [[ ! -f ${directory}/${part}.tsv ]]; then
    printf '%s\t%s\t%s\n' "${part}" "missing" "?" >"${directory}/${part}.tsv"
  fi
  cat "${directory}/${part}.tsv" >>"${directory}/results.tsv"
  IFS=$'\t' read -r name part_status duration <"${directory}/${part}.tsv"
  [[ ${part_status} == 0 ]] || status=1
  echo "📝 ${name}: exit ${part_status}, ${duration}s"
  printf '| %s | %s | %ss |\n' "${name}" "${part_status}" "${duration}" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
done
exit "${status}"
