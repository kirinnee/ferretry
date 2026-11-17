#!/bin/sh
# The ExecStart of a sweep slot's daemon service (and of its tmux scope): builds the EXACT environment at EVERY exec, then
# execs the program, so the unit's MainPID is the program itself and a Restart=on-failure restart gets the same allow-list.
#
#   /bin/sh fyd-exec.sh <env-program> <env-file> <program> [args…]
#
# A user-manager service inherits the manager's CURRENT environment each time it starts, so a one-time UnsetEnvironment
# snapshot would let a name added later (a credential included) ride in. Here nothing is inherited: `env -i` plus the lines of
# <env-file> (the slot's private 0600 NAME=value file, written by slot.ts from its allow-list), and nothing else.
#
# <env-file> is PARSED, never evaluated: each line is NAME=value, the value everything after the first `=`, taken literally
# (no quoting, no expansion). Fail closed, ALWAYS with exit 78, on anything else: a missing, linked, foreign-owned, unreadable
# or not-exactly-0600 file, an empty file, a line without `=`, a name that is not [A-Za-z_][A-Za-z0-9_]*, a credential-shaped
# name, or a program that is not an absolute executable path without `=`. Uniform means uniform: the EXIT trap below turns any
# other way this script could leave before the exec (a failed read, a command that errors under `set -e`) into 78 too.
# No value is ever printed, put in a unit property or in argv by this script.
set -eu
trap 'exit 78' EXIT

fail() {
  printf 'fyd-exec: refusing: %s\n' "$1" >&2
  exit 78
}

[ "$#" -ge 3 ] || fail 'usage: fyd-exec.sh <env-program> <env-file> <program> [args...]'
envbin=$1
file=$2
shift 2

case "$envbin" in /*) ;; *) fail 'the env program must be an absolute path' ;; esac
[ -x "$envbin" ] || fail 'the env program is not executable'
case "$1" in /*) ;; *) fail 'the program must be an absolute path' ;; esac
case "$1" in *=*) fail 'the program path holds "=" (env would read it as an assignment)' ;; esac
[ -f "$1" ] && [ -x "$1" ] || fail 'the program is not an executable file'
# shellcheck disable=SC3067 # `test -O` (owned by this user) is in dash, bash and busybox sh, just not in the POSIX text
[ -f "$file" ] && [ ! -L "$file" ] && [ -O "$file" ] && [ -r "$file" ] ||
  fail 'the environment file is missing, a link, unreadable, or not owned by this user'
# Exactly 0600: the file holds the daemon's whole environment, so a group- or world-readable (or writable) one is refused.
[ -n "$(find "$file" -perm 600 -print 2>/dev/null)" ] || fail 'the environment file is not mode 0600'
# `cat` (not a redirection on a special builtin, which would end the shell with its own status) proves the file reads.
cat -- "$file" >/dev/null 2>&1 || fail 'the environment file cannot be read'

count=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '') continue ;; esac
  case "$line" in *=*) ;; *) fail 'an environment line has no "="' ;; esac
  name=${line%%=*}
  case "$name" in '' | [0-9]* | *[!A-Za-z0-9_]*) fail 'an environment line has an invalid variable name' ;; esac
  case "$name" in
  *_TOKEN | *_KEY | *_SECRET | *_PASSWORD | *_PASS | *_CREDENTIAL | *_CREDENTIALS) fail "credential-shaped name $name" ;;
  GH_* | GITHUB_* | GIT_* | SSH_* | AWS_* | AZURE_* | GOOGLE_* | GCLOUD_* | NPM_* | DOCKER_*) fail "credential-shaped name $name" ;;
  ANTHROPIC_* | OPENAI_* | CLAUDE_* | CODEX_*) fail "credential-shaped name $name" ;;
  esac
  set -- "$line" "$@"
  count=$((count + 1))
done <"$file"

[ "$count" -gt 0 ] || fail 'the environment file holds no variables'
trap - EXIT
exec "$envbin" -i "$@"
