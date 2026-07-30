---
id: authorization
title: Authorization (parked)
---

# Authorization (parked)

Ferretry has no authorization surface yet: today the repo ships a local CLI only. The
authentication/authorization model for the product — device pairing, per-device revocable
tokens, WebSocket tickets, and link-level protection (tailnet ACLs, Cloudflare Access) — is
specified in `docs/design/split-proposal.md` §5–6 and lands with the daemon/PWA phases.

This subject is parked, not dropped: the upstream diene standard
(`bun-cli:docs/standards/authorization/index.md` in the diene repo) covers OAuth/OIDC token
flows that do not describe this repo. When the daemon's pairing and device-token work starts
(backlog phase 3), this page becomes the doctrine for Ferretry's real trust model, written
against the design doc rather than ported wholesale.
