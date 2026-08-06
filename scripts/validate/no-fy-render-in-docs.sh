#!/usr/bin/env bash
set -euo pipefail

# Fails when an `fy-render` fence opener appears anywhere outside the two files that teach the syntax.
#
# `fy-render` is a fenced block that renders an illustration in ONE surface: an assistant's own chat
# message in the transcript (`AssistantProse`). It is inert everywhere else in the app by a
# defaulted-off opt-in prop, and it is forbidden outright in every durable artifact this repository
# ships — documentation, handovers, READMEs, specs, source files, exported artifacts. A diagram in a
# document is an ordinary fenced block in that document's own format, never an `fy-render` block.
# The authoring contract is docs/fy-render.md; the one-screen teaching surface is
# .claude/skills/fy-render-authoring/SKILL.md.
#
# A prohibition nobody enforces is a comment. This gate makes it a contract.
#
# ## THE OPENER, MATCHED AGAINST THE RENDERER'S REAL ACTIVATION GRAMMAR
#
# The prohibition is only worth as much as its agreement with what actually renders. remark produces
# the SAME `code` node — and therefore the same activation — for every CommonMark fence form:
#
#   * a run of THREE OR MORE backticks, not just exactly three;
#   * a run of three or more TILDES;
#   * a fence nested inside a blockquote or a list item, where the delimiter is not at column zero.
#
# A gate anchored to a line start with three exact backticks would pass all three of those while the
# product rendered them, so the pattern below requires none of it: a delimiter RUN of either kind,
# the token, and then only whitespace to end of line, wherever on the line that lands.
#
# Anchoring to end-of-line is the part that must stay. It is what keeps a DIFFERENT fence — one
# labelled `fy-render-x`, or an info string `fy-render notes` — from being reported, and that also
# matches the renderer exactly: the remark plugin marks a fence only when the token is the WHOLE info
# string, so a fence this gate ignores is a fence the product ignores too.
# `packages/pwa/tests/unit/markdown.test.tsx` pins both halves of that agreement.
#
# ## WHY THE TOKEN IS ASSEMBLED, NOT WRITTEN
#
# The backtick run is built from a hex-escaped backtick rather than typed literally. That keeps this
# script's own source free of the exact token it searches for, so it cannot match itself and the
# allowlist holds exactly the two teaching files with no third mechanical self-exemption. This
# mirrors the conflict-markers gate's stance that a teaching document shows a shape exactly rather
# than one character off — but a validator's job is to FIND the shape, not to teach it, so here it is
# assembled on purpose.
#
# ## FILE SET
#
# `git grep` searches tracked working-tree files — exactly what a commit contains — so a scratch file
# nobody is committing cannot fail somebody's commit. The two teaching files are exempt by exact path.
#
# Exit codes follow the repo convention: 0 clean, 1 a violation, 2 a broken gate (a real git-grep
# error rather than a clean tree).

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

bt=$'\x60' # one backtick, via hex escape — see note above
# Either delimiter run CommonMark accepts, at three or more, anywhere on the line (so a fence nested
# under a blockquote or list marker is found), then the token, then only whitespace to end of line.
opener="(${bt}{3,}|~{3,})fy-render[[:space:]]*\$"

# The only two files that may legitimately contain the opener. Both exist to teach the syntax;
# everything else is damage.
allowed_paths=(
  "docs/fy-render.md"
  ".claude/skills/fy-render-authoring/SKILL.md"
)

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

# git grep exits 1 for no-match and >1 for a real error (bad pattern, unreadable object). `||`
# captures the status without tripping errexit; anything above 1 means the scan itself is broken and
# a broken scan must never read as a clean tree.
status=0
git grep -n -E "${opener}" >"${tmp_dir}/raw" 2>"${tmp_dir}/err" || status=$?
case "${status}" in
0 | 1) ;;
*)
  echo "❌ git grep failed (exit ${status}) while searching for the fy-render fence opener:" >&2
  cat "${tmp_dir}/err" >&2
  exit 2
  ;;
esac

# One `git grep -n` line is `<path>:<line>:<text>`, so the path is everything before the first colon.
# A declared path answers only for itself: exempting a file cannot exempt a neighbour.
is_allowed() {
  local needle="$1" allowed
  for allowed in "${allowed_paths[@]}"; do
    [ "${needle}" = "${allowed}" ] && return 0
  done
  return 1
}

violations=''
while IFS= read -r match || [ -n "${match}" ]; do
  [ -z "${match}" ] && continue
  path="${match%%:*}"
  is_allowed "${path}" && continue
  violations+="${match}"$'\n'
done <"${tmp_dir}/raw"

if [ -n "${violations}" ]; then
  echo "❌ fy-render fence openers are conversation-only and must not appear in durable files:" >&2
  printf '%s' "${violations}" | sed '/^$/d' >&2
  cat >&2 <<'GUIDANCE'

`fy-render` renders only inside an assistant's own transcript message (AssistantProse) and is inert
everywhere else in the app. It must NEVER be used in documentation, handovers, READMEs, specs, source
files, or exported artifacts — use the document's native format and ordinary static assets instead.
A Mermaid diagram in a document is an ordinary fenced block, never an fy-render block.

The syntax is taught in exactly two places, and they are the only files that may contain the opener:
  - docs/fy-render.md                           (the contract)
  - .claude/skills/fy-render-authoring/SKILL.md (the authoring skill)

A test or example that must name the token assembles it (see packages/pwa/tests/unit/markdown.test.tsx).

See docs/fy-render.md for the full grammar, the threat model and the declared gaps.
GUIDANCE
  exit 1
fi

scanned="$(git ls-files | wc -l | tr -d ' ')"
echo "✅ no fy-render fence openers outside their two teaching files: ${scanned} tracked files searched, opener allowed only in docs/fy-render.md and .claude/skills/fy-render-authoring/SKILL.md"
