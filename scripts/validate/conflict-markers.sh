#!/usr/bin/env bash
set -euo pipefail

# Fails the commit that leaves a merge-conflict marker in a tracked file.
#
# ## WHY THIS IS A GATE AND NOT A HABIT
#
# `docs/grants.md` shipped to `main` carrying THREE live markers and eleven green CI checks. Nobody
# was careless: every gate was correct about the artefact it was handed, and the artefact was not
# what anybody had reviewed.
#
#   <<<<<<< HEAD    an ordinary paragraph line to a Markdown formatter. Nothing to reformat, nothing
#                   to complain about, and no other check looks for it.
#   =======         ALREADY VALID MARKDOWN WITH A MEANING. A row of `=` under a paragraph is a setext
#                   H1 underline, so the marker did not merely survive — it turned the sentence above
#                   it into a top-level heading. It renders as intended structure rather than damage.
#   >>>>>>> <sha>   treefmt rewrote it to `> > > > > > > <sha>`: a legal nested blockquote. The raw
#                   string no longer existed, so a grep for the raw form afterwards was vacuously
#                   clean while the defect sat in the file.
#
# The last one is the reason this script knows about the LAUNDERED shape as well as the raw one. A
# formatter that repairs invalid content into valid content defeats a check that only knows what the
# author typed, and the doc that argues against stacked contradictions is the doc it happened in.
#
# ## DO NOT SIMPLIFY THE PATTERN LIST. MEASURED AGAINST THE SHIPPED FILE:
#
#   grep the marker somebody REPORTS   (raw '>>>>>>>')         0 of 3 artefacts
#   grep all three raw markers                                 2 of 3 — misses the laundered one
#   this list                                                  3 of 3
#
# The laundered patterns are not belt-and-braces on top of the raw ones. In a repository that formats
# every file on commit they are the ONLY thing that still matches, so a raw-marker-only gate is not
# partial cover — it is no cover for the artefact most likely to survive review.
#
# ## WHAT IT REFUSES
#
# Every raw marker ANYWHERE on a line of a tracked file, and the Markdown-laundered blockquote form of
# each. Anywhere rather than line-anchored on purpose: the laundered shape arrives indented inside a
# nested blockquote, and a prefix-only search would have missed the one artefact that survived
# formatting. `=======` is the single exception and is matched only as a WHOLE line — a setext
# underline is the only thing it can be, and any length of `=` rule in prose is written another way
# here.
#
# ## DOCS ABOUT DAMAGE DECLARE THEMSELVES — THEY DO NOT REWORD THE SHAPE
#
# Matching anywhere on a line means this gate finds the files that TEACH the shapes as well as the
# files that are broken by them, and this script is the first of those: it cannot search for a marker
# it is forbidden to write. That used to be a hardcoded `':!scripts/validate/conflict-markers.sh'`
# pathspec on every search, which exempted exactly one file and answered nothing about the next one.
#
# `scripts/validate/conflict-markers-allowlist.txt` is that exemption, generalised into a DECLARATION:
# an exact path plus a reason specific to that file. The alternative — rewording the marker inside the
# document so the search misses it — is forbidden there and worth restating here, because it is the
# tempting fix. A document that shows the shape one character off teaches the wrong shape, and the
# reader who copies it into their own check gets a check that matches nothing. That is how
# `docs/grants.md` shipped in the first place.
#
# A malformed, reasonless, globbed or duplicated declaration is exit 2 rather than exit 1: a broken
# exemption list is a broken gate, and a broken gate must never report a clean tree.
#
# ## FILE SET, PATTERN, AND UNIT
#
# The file set is every file `git grep` searches — exactly what a commit contains, tracked only, so a
# scratch file nobody is committing cannot fail somebody's commit. The patterns are the six literal
# and anchored shapes below; one matching line is one unit. Compared with `--fixed-strings` throughout
# because `rg -r` is `--replace` and a pattern search for `<<<` in a shell would be one quoting
# mistake away from a different question — `git grep -F` treats each shape as a literal, so nothing
# here is a regex and no character needs escaping.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

allowlist="scripts/validate/conflict-markers-allowlist.txt"
[ ! -f "${allowlist}" ] && echo "❌ missing conflict-marker allowlist: ${allowlist}" >&2 && exit 2

# ─── declarations ─────────────────────────────────────────────────────────────────────────────

trim() {
  local text="$1"
  text="${text#"${text%%[![:space:]]*}"}"
  printf '%s' "${text%"${text##*[![:space:]]}"}"
}

declare -A declared_reason
declared_order=()
line_number=0

while IFS= read -r raw_line || [ -n "${raw_line}" ]; do
  line_number=$((line_number + 1))
  line="$(trim "${raw_line}")"
  [ -z "${line}" ] && continue
  case "${line}" in '#'*) continue ;; esac

  at="${allowlist}:${line_number}"
  case "${line}" in
  *'#'*) ;;
  *)
    echo "❌ ${at}: entry needs a trailing '# <reason>' naming what this file quotes and why" >&2
    exit 2
    ;;
  esac

  path="$(trim "${line%%#*}")"
  reason="$(trim "${line#*#}")"

  [ -z "${reason}" ] && echo "❌ ${at}: entry needs a non-empty reason (${path})" >&2 && exit 2
  # A path cannot be empty here — the line is trimmed and does not begin with `#`, so everything
  # before the separator is at least one character. Whitespace inside it is the reachable mistake:
  # it means the `#` is missing from a line that reads like prose.
  case "${path}" in
  *[[:space:]]*)
    echo "❌ ${at}: a path has no spaces in it — is the '# <reason>' separator missing? (${path})" >&2
    exit 2
    ;;
  esac
  case "${path}" in
  *[][*?]*) echo "❌ ${at}: globs are forbidden — name the exact file (${path})" >&2 && exit 2 ;;
  */) echo "❌ ${at}: directories are forbidden — name the exact file (${path})" >&2 && exit 2 ;;
  /* | ../* | */../* | */..) echo "❌ ${at}: paths are exact and repo-relative (${path})" >&2 && exit 2 ;;
  esac
  if [ -n "${declared_reason[${path}]+set}" ]; then
    echo "❌ ${at}: duplicate declaration (${path}) — one of the two reasons is already stale" >&2
    exit 2
  fi

  declared_reason["${path}"]="${reason}"
  declared_order+=("${path}")
done <"${allowlist}"

[ "${#declared_order[@]}" -eq 0 ] &&
  echo "❌ ${allowlist} declares nothing — this script itself has to be in it, so the parse is broken" >&2 &&
  exit 2

# ─── the search ───────────────────────────────────────────────────────────────────────────────

# Every marker a resolution can leave behind, raw and laundered. `git grep -F` treats each as a
# literal, so nothing here is a regex and no character needs escaping.
raw_markers=('<<<<<<<' '>>>>>>>' '|||||||')
laundered_markers=('< < < < < < <' '> > > > > > >')

# `git grep` exits 1 for no-match and >1 for a real error (bad pattern, unreadable object, a broken
# config) — `|| true` used to collapse both to an empty result, so an errored search still printed
# the clean-tree line below, exactly what `:58-59` forbids. `$?` here is the grep's own exit status:
# it is read before any other command runs, so a no-match 1 returns quietly and anything higher exits
# the gate itself.
die_on_grep_error() {
  local status="$1" what="$2"
  [ "${status}" -le 1 ] && return 0
  echo "❌ git grep failed while searching for ${what} (exit ${status}) — the scan is broken, not the tree" >&2
  exit 2
}

matches=''

for marker in "${raw_markers[@]}" "${laundered_markers[@]}"; do
  found="$(git grep -n -F -e "${marker}")" || die_on_grep_error "$?" "the '${marker}' marker"
  [ -n "${found}" ] && matches+="${found}"$'\n'
done

# The setext case, which is a whole line rather than a prefix. Seven `=` is what git writes.
found="$(git grep -n -E '^=======$')" || die_on_grep_error "$?" "the setext '=======' line"
[ -n "${found}" ] && matches+="${found}"$'\n'

# ─── attribution ──────────────────────────────────────────────────────────────────────────────

# One `git grep -n` line is `<path>:<line>:<text>`, so the path is everything before the first colon.
# A declared path answers for its own matches and for nothing else: exempting a file cannot exempt a
# neighbour, which is why the list holds no globs.
findings=''
declare -A matched_declaration

while IFS= read -r match; do
  [ -z "${match}" ] && continue
  path="${match%%:*}"
  if [ -n "${declared_reason[${path}]+set}" ]; then
    matched_declaration["${path}"]='yes'
    continue
  fi
  findings+="${match}"$'\n'
done <<<"${matches}"

if [ -n "${findings}" ]; then
  echo "❌ merge-conflict markers are still in the tree:" >&2
  printf '%s' "${findings}" | sed '/^$/d' >&2
  # Quoted heredoc, so the laundered shapes below stay literal rather than needing four backslashes
  # in a paragraph whose whole job is showing them exactly.
  cat >&2 <<'GUIDANCE'

Resolve the conflict to the correct FINAL TEXT rather than deleting the marker lines: a document
carrying both versions of a paragraph is the defect, and the markers are only how it is visible.

`> > > > > > >` and `< < < < < < <` are treefmt's rewrite of a raw marker in Markdown. Finding one
means the file was formatted after the resolution, so search before the formatter runs — or search
`git diff` — if you want the raw form to still be there.
GUIDANCE
  cat >&2 <<GUIDANCE

If the file DOCUMENTS these shapes rather than being damaged by one, declare it in ${allowlist}:
an exact path and a reason specific to that file. Never reword a marker to slip past this search — a
document that shows the shape one character off teaches the wrong shape.
GUIDANCE
  exit 1
fi

# ─── report ───────────────────────────────────────────────────────────────────────────────────

# A declaration that describes nothing is printed rather than refused. Two ways that happens and
# neither is a defect: the path has not landed yet (a seed for an open PR), or the document was
# rewritten and no longer shows the shape. The allowlist header says why this is not a hard failure.
unused=()
for path in "${declared_order[@]}"; do
  [ -n "${matched_declaration[${path}]+set}" ] && continue
  if [ -e "${path}" ]; then
    unused+=("${path} — present and quotes no marker shape; delete the line")
  else
    unused+=("${path} — not in this tree yet; a seed, and still pending")
  fi
done

scanned="$(git ls-files | wc -l | tr -d ' ')"
echo "✅ no undeclared merge-conflict markers: ${scanned} tracked file units searched for 6 raw/laundered/setext shapes (one matching line is one unit), ${#declared_order[@]} declared documentation exemptions"
if [ "${#unused[@]}" -gt 0 ]; then
  echo "⚠️  ${#unused[@]} declaration(s) in ${allowlist} describe nothing right now:"
  printf '   %s\n' "${unused[@]}"
fi
