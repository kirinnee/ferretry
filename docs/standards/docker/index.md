---
id: docker
title: Docker (parked)
---

# Docker (parked)

Ferretry does not ship container images yet — the CLI is distributed as standalone compiled
binaries (Homebrew cask, curl|bash installer, GitHub release archives), and the daemon is not
containerized.

This subject is parked, not dropped: the upstream diene standard
(`bun-cli:docs/standards/docker/index.md` in the diene repo) defines image build/run
conventions that will be re-adapted here if and when Ferretry publishes images (for example a
containerized `fyd`). Until then there is deliberately no Docker machinery in this repo — do
not add Dockerfiles, compose files, or image tasks without reviving this standard first.
