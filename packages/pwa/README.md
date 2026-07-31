# pwa

The multi-daemon web app, centrally hosted as static files with a daemon-served fallback.

The initial seam deliberately has no default daemon. Pairing supplies each connection at runtime;
every session cache/store key is `(daemonId, sessionId)`, and transport URLs are resolved from that
connection rather than the page origin. Later browser-feature units build on these exports.
