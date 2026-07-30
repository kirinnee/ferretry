# Survey B — shared types, auth, and version skew

Completed a read-only source survey of `/home/kirin/.config/home-manager/modules/kteam-ts/src` and `ui/src` covering shared wire types, runtime validation, authorization/capability headers, version-skew behavior, and factual server/UI inconsistencies.

Delivered citation-ready findings directly to `/root` and `/root/http_routes` in four batches:

- auth/capability model and version-skew behavior;
- core session/event/request types and generic validation gaps;
- attachments, browser/login, terminals, filesystem/git, tasks/boards/pins, Attention, and warden types;
- STT, push, learning, analytics, cgroups, PWA, warden config, runtime models, and skills.

Key facts include `KTEAM_VERSION = 0.2.1`, bearer/warden/board/stop capability gates, honest-client actor attribution, no Zod usage in surveyed source, syntax-only generic JSON casting, and all identified server/UI shape disagreements.

Per lead instruction, did not create or edit `/tmp/fy-migration-survey/api-surface.md`. No repository or Home Manager source files were modified, and no live daemon/session data was inspected.
