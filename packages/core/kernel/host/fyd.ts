#!/usr/bin/env bun
/**
 * The `fyd` host file (≤150 lines, names no subsystem; §7.6). Owned by spine slice 1 (Kernel host); a stub until
 * it lands. Declared here only so the release machinery (scripts/release/compile.sh, nix/ferretry.nix,
 * .goreleaser.yaml) has the daemon entry it compiles: the kernel package's first `bin` key.
 */
process.exitCode = 0;
