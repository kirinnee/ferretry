#!/usr/bin/env bash
set -euo pipefail

# Fail when a composition-root world field is DECLARED and CONSTRUCTED but never CALLED.
#
# The reachability gate beside this one catches a module no importer reaches. It is blind to the
# second shape of dead capability: a service the composition root imports, constructs, assigns to a
# world field — and then nothing ever reads. `SessionResumeService` sat that way through four wiring
# units. `createSessionResume` was a world field nothing invoked, so `POST /v1/sessions/:id/resume`
# answered `unknown_route` while the module reported 100% coverage and stayed off the allowlist.
# Wiring it finally surfaced three defects no unit test had reached, including a revive that wrote
# `needsHumanKind: null` into a document the protocol says holds a string, so every surface that
# parses before serving dropped the session it had just revived.
#
# Rule: a field appears exactly twice in the composition root when it is only declared on the
# interface and populated in the world literal. A third mention, or any mention in another file, is
# a genuine read. Two or fewer means nothing calls it.
#
# COMMENTS ARE NOT MENTIONS, and that is not a nicety. This composition root is documented in prose
# as dense as its code, and the first unit to run this gate silenced it by accident: a comment
# explaining why `world.transcripts` has no caller counted as the third mention and passed the very
# field it was documenting. A gate a sentence can turn off is worse than no gate, because the field
# it stops reporting looks wired.
#
# NEITHER ARE STRING LITERALS, for the same reason and a worse one. `DaemonWorld.stt` was constructed
# and called by nothing while `fy stt` spoke five routes to a daemon that answered `unknown_route`,
# and BOTH halves of the rule above were satisfied by substrings rather than by a call: `\bstt\b`
# matches inside the composition root's own `'./stt-worker.ts'` import, which made `in_root` three,
# and it matches the path of every module under `src/lib/stt` and `src/adapters/stt`, which made
# `elsewhere` true. A field whose name is a short, common substring was therefore invisible to this
# gate — the exact failure it exists to prevent. Strings are stripped before counting now.
#
# AND A MENTION ELSEWHERE MUST LOOK LIKE A READ. `elsewhere` used to accept the bare word anywhere in
# the package, so an unrelated local, parameter or type of the same name spoke for the field. It now
# requires a property access (`.field`) or a destructure/shorthand (`field,` / `field}`), which are
# the only shapes a world field can actually be read through.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"
status=0
blocked_file="scripts/validate/invocation-blocked.txt"
declared=""
stale=""

# Source text with `//` and `/* */` stripped, so only code is counted. A `//` inside a string
# literal truncates the rest of that line, which can only ever hide a mention — the conservative
# direction for a gate whose failure mode is a capability quietly reported as wired.
strip_comments() {
  awk '
    {
      line = $0
      while (1) {
        if (block) {
          stop = index(line, "*/")
          if (stop == 0) { line = ""; break }
          line = substr(line, stop + 2); block = 0
        } else {
          open = index(line, "/*")
          if (open == 0) break
          rest = substr(line, open + 2)
          stop = index(rest, "*/")
          if (stop == 0) { line = substr(line, 1, open - 1); block = 1; break }
          line = substr(line, 1, open - 1) substr(rest, stop + 2)
        }
      }
      sub(/\/\/.*/, "", line)
      print line
    }
  ' "$1"
}

# Source text with string literals blanked. A field name inside a string is never a call to it — it
# is an import path, a route, or a message — and an import path is how the one field this gate has
# missed so far hid from it. Nesting is not handled and does not need to be: the worst a mis-paired
# quote can do is erase MORE text, which can only ever hide a mention, the conservative direction.
strip_strings() {
  # The template-literal delimiter is written as \x60 rather than as itself: a literal backtick
  # inside a single-quoted argument reads as an attempted command substitution to shellcheck.
  sed -E -e "s/'[^']*'//g" -e 's/"[^"]*"//g' -e 's/\x60[^\x60]*\x60//g'
}

check_root() {
  local file="$1" interface="$2" package_src="$3"
  [ -f "${file}" ] || return 0

  local fields
  fields="$(awk -v want="${interface}" '
    $0 ~ "interface "want" \\{" { inside = 1; next }
    inside && /^\}/            { inside = 0 }
    inside && match($0, /readonly [A-Za-z_][A-Za-z0-9_]*/) {
      print substr($0, RSTART + 9, RLENGTH - 9)
    }
  ' "${file}" | sort -u)"
  [ -z "${fields}" ] && return 0

  local root_code
  root_code="$(strip_comments "${file}")"

  local unused=""
  stale=""
  for field in ${fields}; do
    local in_root elsewhere
    # `|| true` matters: grep exits non-zero on no match, and `set -e` with `pipefail` would
    # abort the whole gate on the first field that happens to be absent.
    in_root="$({ printf '%s\n' "${root_code}" | strip_strings | grep -oE "\b${field}\b" || true; } | wc -l)"
    # Candidate files first — a deliberately LOOSE prefilter, because it may only ever add files for
    # the authoritative check below to reject. That check reads each one with comments and strings
    # removed and demands a read-shaped mention: a name that survives only inside a doc block, an
    # import path or a message is documentation about the field, not a call to it.
    elsewhere=0
    while IFS= read -r candidate; do
      [ -n "${candidate}" ] || continue
      if strip_comments "${candidate}" | strip_strings | grep -qE "[.]${field}\b|\b${field}\b[,}]"; then
        elsewhere=1
        break
      fi
    done <<<"$({ grep -rlE "\b${field}\b" "${package_src}" 2>/dev/null || true; })"
    if [ "${in_root}" -le 2 ] && [ "${elsewhere}" -eq 0 ]; then
      # A field may be DECLARED blocked — calling it would be wrong or impossible — in
      # invocation-blocked.txt, with the blocker stated. Anything else fails.
      if grep -qE "^${interface}\.${field} # " "${blocked_file}" 2>/dev/null; then
        declared="${declared} ${interface}.${field}"
      else
        unused="${unused}   ${interface}.${field}"$'\n'
      fi
    else
      # A declared field that is now called is a stale entry: the list must shrink, so this is
      # a hard failure rather than a silent pass.
      if grep -qE "^${interface}\.${field} # " "${blocked_file}" 2>/dev/null; then
        stale="${stale}   ${interface}.${field}"$'\n'
      fi
    fi
  done

  if [ -n "${unused}" ]; then
    echo "❌ constructed but never called in ${file}:" >&2
    printf '%s' "${unused}" >&2
    echo "   Wire each into a caller, or delete it. If calling it would be WRONG or IMPOSSIBLE," >&2
    echo "   declare it in ${blocked_file} with the blocker stated as a checkable fact." >&2
    status=1
  fi

  if [ -n "${stale}" ]; then
    echo "❌ stale entries in ${blocked_file} — these are called now, delete them:" >&2
    printf '%s' "${stale}" >&2
    status=1
  fi
}

check_root packages/daemon/bin/fyd.ts DaemonWorld packages/daemon/src
check_root packages/cli/bin/fy.ts CliWorld packages/cli/src

if [ "${status}" -ne 0 ]; then
  echo "   Each is a capability the product does not have: the code is built, tested and" >&2
  echo "   assigned, and nothing invokes it. Wire it into a caller, or delete it." >&2
  echo "   The reachability gate cannot see this shape — that is why this gate exists." >&2
  exit 1
fi
n="$(grep -cE "^[A-Za-z]+\.[A-Za-z]+ # " "${blocked_file}" 2>/dev/null || echo 0)"
if [ "${n}" -gt 0 ]; then
  echo "✅ Every composition-root field is called, or declared blocked (${n} declared)"
else
  echo "✅ Every composition-root field is called by something"
fi
