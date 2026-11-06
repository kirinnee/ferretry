#!/usr/bin/env bash
set -euo pipefail

# The consolidated jobs install once before starting any parallel part.
[[ ${FY_CI_SETUP_DONE:-} == 1 ]] && exit 0

./scripts/local/setup.sh

echo "✅ Repository setup complete"
