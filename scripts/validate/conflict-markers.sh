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
# ## WHAT IT REFUSES
#
# Raw markers at the start of a line, in any tracked file, and the Markdown-laundered blockquote form
# of each. `=======` is matched only as a WHOLE line: a setext underline is the only thing it can be,
# and any length of `=` rule in prose is written some other way in this repository.
#
# Compared with `--fixed-strings` throughout, because `rg -r` is `--replace` and a pattern search for
# `<<<` in a shell would be one quoting mistake away from a different question. This script uses
# `git grep -F` for the same reason, and because it scans exactly what a commit contains.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

# Every marker a resolution can leave behind, raw and laundered. `git grep -F` treats each as a
# literal, so nothing here is a regex and no character needs escaping.
raw_markers=('<<<<<<<' '>>>>>>>' '|||||||')
laundered_markers=('< < < < < < <' '> > > > > > >')

findings=''

for marker in "${raw_markers[@]}"; do
  # `-e` with a literal and `-n` for the line: the marker only ever begins a line, and matching it
  # anywhere would refuse this very file, which has to be able to name what it looks for.
  found="$(git grep -n -F -e "${marker}" -- ':!scripts/validate/conflict-markers.sh' || true)"
  [ -n "${found}" ] && findings+="${found}"$'\n'
done

for marker in "${laundered_markers[@]}"; do
  found="$(git grep -n -F -e "${marker}" -- ':!scripts/validate/conflict-markers.sh' || true)"
  [ -n "${found}" ] && findings+="${found}"$'\n'
done

# The setext case, which is a whole line rather than a prefix. Seven `=` is what git writes.
found="$(git grep -n -E '^=======$' -- ':!scripts/validate/conflict-markers.sh' || true)"
[ -n "${found}" ] && findings+="${found}"$'\n'

if [ -n "${findings}" ]; then
  echo "❌ merge-conflict markers are still in the tree:" >&2
  printf '%s' "${findings}" | sed '/^$/d' >&2
  cat >&2 <<'GUIDANCE'

Resolve the conflict to the correct FINAL TEXT rather than deleting the marker lines: a document
carrying both versions of a paragraph is the defect, and the markers are only how it is visible.

`> > > > > > >` and `< < < < < < <` are treefmt's rewrite of a raw marker in Markdown. Finding one
means the file was formatted after the resolution, so search before the formatter runs — or search
`git diff` — if you want the raw form to still be there.
GUIDANCE
  exit 1
fi

echo "✅ no merge-conflict markers, raw or Markdown-laundered"
