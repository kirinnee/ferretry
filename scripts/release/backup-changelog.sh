#!/usr/bin/env bash
set -euo pipefail

# Save the previous changelog so publish.sh can diff this version's section for release notes.
cp Changelog.md Changelog.old.md 2>/dev/null || touch Changelog.old.md
echo "✅ Changelog baseline saved to Changelog.old.md"
