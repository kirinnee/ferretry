#!/usr/bin/env bash
set -euo pipefail

# Conventional-commit gate for the commit-msg hook. `release` is the semantic-release commit type.
msg_file="${1:-}"
[ -z "${msg_file}" ] && echo "❌ usage: $0 <commit-msg-file>" >&2 && exit 2

subject="$(head -n 1 "${msg_file}")"

# Merge and fixup commits pass through untouched.
case "${subject}" in
Merge\ * | fixup!\ * | squash!\ * | Revert\ *) exit 0 ;;
esac

pattern='^(amend|build|chore|ci|config|dep|docs|feat|fix|perf|refactor|release|revert|style|test)(\([a-z0-9./-]+\))?!?: .+'
if ! [[ ${subject} =~ ${pattern} ]]; then
  echo "❌ commit subject is not a conventional commit:" >&2
  echo "   ${subject}" >&2
  echo "   expected: <type>(<scope>)?: <description>" >&2
  exit 1
fi

echo "✅ conventional commit"
