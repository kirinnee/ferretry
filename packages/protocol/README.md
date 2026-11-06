# protocol

Zod schemas for every daemon API type plus the typed client SDK shared by the CLI and PWA.
It holds the wire shapes for sessions, the fleet, the board, the agenda, pairing and browser control, so the daemon, CLI and PWA never declare a copy of their own.
