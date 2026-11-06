#!/usr/bin/env bash
set -euo pipefail

# Run every named part, preserving each exit code and log even when a sibling fails.
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

# A batch bounds local memory without requiring a new runtime or losing any part's result.
for ((start = 0; start < ${#parts[@]}; start += limit)); do
  pids=()
  for ((index = start; index < start + limit && index < ${#parts[@]}; index++)); do
    part=${parts[index]}
    (
      started=${SECONDS}
      set +e
      "${command[@]}" "${part}" >"${directory}/${part}.log" 2>&1
      part_status=$?
      printf '%s\t%s\t%s\n' "${part}" "${part_status}" "$((SECONDS - started))" >"${directory}/${part}.tsv"
      exit "${part_status}"
    ) &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do
    wait "${pid}" || status=1
  done
done

printf '\n| Part | Exit | Duration |\n| --- | --- | --- |\n' >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
for part in "${parts[@]}"; do
  echo "📝 ${part} output"
  cat "${directory}/${part}.log"
  cat "${directory}/${part}.tsv" >>"${directory}/results.tsv"
  IFS=$'\t' read -r name part_status duration <"${directory}/${part}.tsv"
  echo "📝 ${name}: exit ${part_status}, ${duration}s"
  printf '| %s | %s | %ss |\n' "${name}" "${part_status}" "${duration}" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
done
exit "${status}"
