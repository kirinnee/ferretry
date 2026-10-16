# Configuration files

A machine's settings are **human-editable YAML files** under `<FY_HOME>/config/`, one per building
block. The files are the source of truth: the app, `fy` and agents are all editors of them, and the daemon
watches the directory, checks every file, and keeps the last good version of a file in effect while a newer
one is broken. This page is the design note; the code is `@ferretry/fleet`'s `config-files/` (pure),
`packages/daemon/src/lib/config-files/` and `packages/protocol/src/lib/config-files.ts` (the layout and the
wire).

## Layout

| File                            | Holds                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `machine.yaml`                  | Agent permissions, the default runtime, what agents may control, the advanced block               |
| `logins/<id>.yaml`              | one login (a credential): `harness`, `store`, `label`, `env`                                      |
| `components/<kind>/<name>.yaml` | one component; `<kind>` is `instructions`, `mcp`, `skills`, `settings`, `hooks` or `modelSets`    |
| `profiles/<name>.yaml`          | `contents:` — components and other profiles, in order; a later entry overrides an earlier one     |
| `runtimes/<name>.yaml`          | one runtime: `credential`, `profile`, `agent`                                                     |
| `warden.yaml`                   | the Warden's settings; anything left out is the default (off)                                     |
| `learning.yaml`                 | lesson mining                                                                                     |
| `voice.yaml`                    | who cleans up dictated text — transcription is Parakeet in the browser and is not configured here |

Every file Ferretry writes starts with `# yaml-language-server: $schema=…`, pointing at
`config/.schema/<kind>.json`, which the daemon writes from the same zod schemas it checks with
(`fy config schema <kind>` prints one). `config/daemon.json` and `config/routing.json` live in the same
directory and are not configuration files in this sense: they are the daemon's own documents.

`fy config path`, `check`, `schema` and `guide` need no daemon. `status`, `show`, `write` and `confirm` ask it:
`fy config write <file> [--if-match <etag>]` reads the text from stdin and is refused whole unless it checks.

## How a file is read

Each file is checked on its own — YAML syntax, then the raw-secret detector, then its schema — and the
fleet's files are then assembled into one account model and checked together (a profile naming a component
that is not there). Three rules, in order:

1. **Last good wins.** A file that fails a check is reported with its path, line, column and a plain fix
   (`GET /v1/config/status`, `fy config check`, the daemon log, the app's Files panel), and the version the
   daemon accepted before stays in effect. Nothing half-applies. When the fleet does not assemble, every
   fleet change of that round is held back and the machine keeps the fleet it had.
2. **Loosening waits for the owner.** An edit that loosens what the machine may spend or what agents may do
   is HELD and the tighter version stays in effect: the Warden turned on, its concurrency raised or its
   cadence shortened; lesson mining turned on or its caps raised; an agent control turned on (Ferretry
   settings included); Agent permissions set to `skip`; dictated text sent to a provider. Tightening always
   applies at once. Deleting a file is an edit to its defaults and is judged the same way. The owner confirms
   a held edit by its etag — at the machine with `fy config confirm <file>`, or in the app with a passkey
   proved for that act (`loosen-config`) — so a confirmation can never put into effect an edit nobody saw.
3. **The daemon's own writes are acknowledged.** A reviewed fleet change, a first-run import, a clone and
   the Warden settings form record the text they write as accepted before writing it, so the owner's own
   act is never held as if somebody else made it.

What is in effect is recorded in the state home (`state/config-accepted.json`), file by file with its text,
so a last good version survives a restart and a confirmed loosening is not asked about again. A missing or
unreadable record reads as empty — every file judged against the defaults — which holds back any loosening
until it is confirmed again.

The watcher polls a fingerprint of the tree (size, modification time and inode per file) once a second and
loads after a 300 ms quiet period. A platform watcher that follows a tree misses a file created in a new
directory, and a missed save is a broken file nobody is told about.

A link is never followed — not by the daemon, not by `fy config check`. `GET /v1/config/file` returns a
file's text to a caller off the machine, so a link planted in the directory would otherwise read any file
the user can. A link, or a file over 256 KiB, is reported as unreadable and keeps its last good version.

## Secrets never go in a file

A secret lives in the secret store (`fy secret set NAME`) and a file names it as `${secret:NAME}`
([secrets.md](secrets.md)). A file holding anything that looks like a raw key — a known provider prefix
(`sk-`, `sk-ant-`, `sk-or-`, `AKIA…`, `ghp_`, `github_pat_`, `xox…-`, `gsk_`, `csk-`, `AIza…`, `glpat-`)
anywhere, or a high-entropy value under a key ending `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIALS`
— is refused like a file that does not parse, and the issue never repeats the value.

## Editing

Every program that writes a file computes the value it wants and edits the existing text with the `yaml`
package's Document API: only the keys whose value changes are rewritten, a removed key is deleted, a list is
edited item by item, and the owner's comments and key order survive. A default the file leaves out stays
left out.

| Editor                           | How                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| Any text editor                  | edit, then `fy config check`                                                          |
| A script                         | `fy config show <file>` for the etag, then `fy config write <file> --if-match <etag>` |
| The app                          | Settings › a machine › **Files**: status, issues, Open file path, **Edit as YAML**    |
| `fy component\|profile\|login …` | reviewed fleet changes, written into the files                                        |
| An agent                         | the `config_read`, `config_validate` and `config_write` Ferretry tools                |

## Routes

| Route                       | Grant                                                      | Does                                                   |
| --------------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| `GET /v1/config/status`     | `fleet.use`                                                | every file, its state, every issue, every held edit    |
| `GET /v1/config/file?path=` | the file's capability, `use`                               | one file (or the starter a new one begins with) + etag |
| `PUT /v1/config/file`       | the file's capability, `configure`; `If-Match: <etag>`     | write a file that checks; a loosening may be held      |
| `POST /v1/config/confirm`   | the file's capability, `configure`; fresh passkey remotely | confirm one held edit by its etag                      |
| `POST /v1/agent/config`     | the agent's session credential; Ferretry settings on       | the `config.*` tools                                   |

The file's capability is `warden` for `warden.yaml` and `fleet` for everything else. A loosening `PUT` is in
effect at once only for somebody at the machine or a device that proved a passkey for the act; anyone
else's is written and held. An agent never confirms.

## Agents

"What agents may control › **Ferretry settings**" decides whether an agent may use the `config.*` tools. It
is **off by default**, and turning it on from another device needs a passkey like the other controls. It is a
kill switch, not a boundary: an agent with plain file access can edit the files too. The real guard is rule
2 — an agent's loosening waits for the owner either way.

The built-in **Set up Ferretry** skill teaches any agent the layout, the schemas, the commands and the rules.
It is the Ferretry tools server's instructions in every agent runtime, and `fy config guide` prints it as a
`SKILL.md` to drop into any skills directory.

## Declared gaps

- The fleet's own files apply as written; a component or profile change is not judged for loosening,
  because it changes what an agent runs with, which every editor may already change.
- A reviewed change in the app is made against the configuration IN EFFECT. If `machine.yaml` holds a
  loosening that is waiting, a change saved from the app rewrites that file from the version in effect,
  which drops the waiting edit — confirm or revert it first.
- There is no back-compat: a `fleet/config.yaml` is refused by sentence ([account-model.md](account-model.md)).
