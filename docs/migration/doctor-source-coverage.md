# Doctor source coverage

| Source capability examined | Ferretry carrier | Coverage |
| --- | --- | --- |
| `modules/kfleet-ts/src/cli/doctor.ts` PATH/config/binary diagnostic | `packages/daemon/src/lib/core/doctor.ts`, `fyd --check`, and `fy doctor` | **PORTED, adapted.** Ferretry reports host dependencies by consequence rather than preserving kfleet flags or output. |
| `modules/kteam-ts/src/harness.ts` and Ferretry `harness-readiness.ts` distinguish PATH from launchability | `readDoctorReport()` receives `readHarnessPreflight()` evidence | **PORTED.** Claude/Codex is ready only when an existing published wrapper can launch; PATH alone is explicitly limited. |
| PWA `defaultFleetHarness()` Claude-first fallback | `packages/pwa/src/features/settings/doctor-settings.tsx` | **PORTED.** The daemon-scoped Doctor tab uses the existing policy over the same reported readiness evidence. |
| Linux `BrowserLoginWindowService` | `readDoctorReport()` platform input | **PORTED.** Linux checks Chrome/Chromium, Xvfb, x11vnc and timeout; other platforms report the human login window unavailable by design. |
| macOS `launchctl` / Linux `systemctl` service management | `readDoctorReport()` platform input | **PORTED.** The unused manager is not applicable, never a missing dependency. |
| `directory-syscalls.ts` platform libc FFI | `fyd --check` and `/v1/doctor` call `loadDirectorySyscalls()` | **PORTED.** The report tests the actual library load rather than inferring success from the platform. |
| Credential storage platform split (PR #240 authority) | — | **NOT EXAMINED.** Doctor does not create a duplicate credential-readiness rule. |
