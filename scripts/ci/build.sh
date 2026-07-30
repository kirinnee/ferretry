#!/usr/bin/env bash
set -euo pipefail

./scripts/ci/setup.sh
./scripts/local/build.sh
