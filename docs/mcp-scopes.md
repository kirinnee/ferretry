# MCP servers in every scope

A ferret's harness reads MCP servers from more places than Ferretry writes. This page says which
places, how Ferretry lists what a ferret actually sees, how it **checks** a server, and how a
**project's** `.mcp.json` server is signed in to. Signing in itself is [mcp-oauth.md](mcp-oauth.md);
read its threat model — everything it says about a token in the agent's environment holds here too.

## Where a ferret's servers come from

"The home" is the **runtime's** config directory under the fleet (`<FY_HOME>/fleet/homes/<id>`, the
manifest's `home`). Ferretry never reads or writes the person's own `~/.claude` or `~/.codex` for this.

| Scope       | Claude Code                                                 | Codex                                                        |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| `ferretry`  | Ferretry's own tools server, passed with `--mcp-config`     | `mcp_servers.ferretry`, a launch override                    |
| `component` | a fleet MCP component, written into the home's `mcpServers` | a fleet MCP component, written into the home's `config.toml` |
| `user`      | anything else in the home's `.claude.json` `mcpServers`     | anything else in the home's `config.toml` `mcp_servers`      |
| `project`   | the repo's `.mcp.json` — only once approved (below)         | the repo's `.codex/config.toml` — only in a trusted project  |
| `local`     | the home's `.claude.json` `projects[<root>].mcpServers`     | —                                                            |

When two scopes declare the same name, Claude uses local › project › user. The ferret's own list marks
the losing declaration `shadowedBy` rather than hiding it; a project server the harness never loads
(not approved, or disabled) hides nothing.

### Approval: why a project server "is listed but never connects"

Read off Claude Code 2.1.281 with `claude mcp list` against a scratch config directory: a `.mcp.json`
server is **Pending approval** — and never started — until it is in
`projects[<root>].enabledMcpjsonServers` **and** the folder's trust question has been answered
(`hasTrustDialogAccepted`), both in the runtime's own `.claude.json`. `<root>` is the checkout's root
(a sub-folder of a repo resolves to it). `enableAllProjectMcpServers` (the project entry, the home's
`settings.json`, or the project's `.claude/settings.json` / `.claude/settings.local.json`) approves
every one, and a name in any `disabledMcpjsonServers` is **disabled** — a deny anywhere wins.

Codex (0.156.1, `codex mcp list` against a scratch home) reads a project's `.codex/config.toml` only
when the home's `config.toml` marks the project `trust_level = "trusted"`; `enabled = false` disables
one server.

Each runtime has its own home, so approval is **per runtime**: the machine list says it per runtime,
and a ferret's list says it for that ferret.

## In the app

- **Info › Context › MCP** (a ferret's Info panel; the Context tab was called Folder): every server that
  ferret sees, labelled **Project**, **Local**, **User** or **Ferretry** (a fleet component and Ferretry's
  own tools server are both Ferretry's), each with where it stands, **Check**, and **Sign in** when a check
  or the server's own setting says it asks for one. A project server nobody approved says so, and a
  server another scope overrides says which.
- **Info › Context › Skills**: every skill that ferret sees, labelled Project, User or Ferretry, with
  "Overridden by …" on the losers of a same-name clash, and **Open** to read its SKILL.md.
- **Settings › Machine › Components › MCP servers**: each row carries the same status, Check and Sign in.
  Components stays the place to create and edit servers and skills.

A failure in these places is said in plain words — "Liftoff MBP isn't reachable right now" — with the
transport's own text behind **Details**.

## Listing

| Route                                     | Capability / axis  | Answers                                |
| ----------------------------------------- | ------------------ | -------------------------------------- |
| `GET /v1/mcp`                             | `fleet` / use      | every declaration on the machine, once |
| `GET /v1/sessions/:sessionId/mcp/servers` | `filesystem` / use | exactly what that ferret sees          |
| `POST /v1/mcp/check`                      | `terminal` / use   | one server checked (below)             |

A row carries the server's name, scope, harness, transport (`stdio`, `http`, `sse`), the file that
declares it, the runtimes that see it (each with its approval, for a project server), what it is
shadowed by, its sign-in subject and where that sign-in stands. **It never carries a command's
arguments or environment, an address's query, or a header** — those can hold keys. A document the
daemon cannot read is listed under `problems` by path, without quoting a byte of it.

## Check

A check reaches the server the way the harness would, opens an MCP session (`initialize`,
`notifications/initialized`), lists its tools (following `nextCursor` up to five pages) and answers:

- **connected** — with the server's own name, the tool count and up to 100 tool names;
- **needs-sign-in** — it answered `401`/`403`;
- **not-approved** — a project **command** this ferret's harness has not been allowed to run. Ferretry
  does not run it either: a check is not a way around the question the harness asks before it runs a
  repository's code. A project **web address** is reached whatever its approval (reaching it runs
  nothing here), and the answer says the approval too;
- **error** — anything else, in words: nothing answered at the host, no answer within 10 seconds, an
  HTTP status (with a hint for 404/405: wrong endpoint or transport), a command that could not be
  started, or one that stopped first, with the last line it printed to stderr.

The whole exchange is bounded by one 10-second deadline, and a command's process is killed when the
check ends however it ends. A command starts in the project folder (for a project or local server)
with `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `TMPDIR` and `TERM` from the daemon,
**never the daemon's tokens**, plus the runtime's resolved launch environment, plus its own `env` with
`${VAR}` / `${VAR:-default}` filled the way Claude fills them; a variable nothing holds is named in the
answer. A signed-in server gets its access token as `Authorization: Bearer …`. Every sentence a check
answers goes through the secret redactor first — a server's own error text is the one thing here
nobody controls. Ferretry's own tools server is not checked: every ferret starts its own.

`POST /v1/mcp/check` can start a command, so it is governed as running one (`terminal`/use): a caller
who may open a terminal here could run that command anyway, and one who may not, may not have Ferretry
run it for them. It is not audited — it changes no configuration and grants nobody anything
(`tests/unit/audit/not-audited.ts`).

## Signing in to a project server

**The bug this fixes.** A `.mcp.json` server that asks for OAuth was left to Claude Code to sign in to
itself. Claude's own sign-in sends the browser back to a `localhost` port on the ferret's machine, which
a phone — or a laptop reaching a remote box — can never reach, so a project server was listed, could
not be checked, and could not be signed in to. The PWA marked every project server "does not sign in";
the daemon's sign-in knew only fleet components and answered "There is no MCP server named …".

**Now** a project's web server signs in through the same flow as a component
([mcp-oauth.md](mcp-oauth.md)), filed under its **subject**: `<name>..<project key>`, where the project
key is 12 hex digits of SHA-256 over the root of the **project** it belongs to. A fleet component name
can never contain `..`, so a subject is never mistaken for a component; every worktree of one project
shares the sign-in, and another project's same-named server does not. The secret names are derived from
the subject and the address exactly as for a component (`mcpOAuthSecretNames`), so a `.mcp.json` whose
address changes names a secret nobody holds and the server reads **Needs sign-in** again. A project
server is listed among the sign-ins only once it has one: unlike a component marked `auth: oauth`,
nothing says it must.

**How the token reaches Claude.** At every launch (and relaunch) of a Claude ferret whose folder is in
the project:

1. a token about to expire is renewed, as a component's is;
2. the server is written to the runtime's **local** scope for that folder's root —
   `projects[<root>].mcpServers.<name>` in the runtime's own `.claude.json` — as the same address with
   `Authorization: Bearer ${FY_MCP_<NAME>_<HASH>_TOKEN}`. Claude uses a local server in place of a
   same-named project one, and expands `${VAR}` in its headers from its own environment;
3. the variable is added to the launch environment, resolved. A profile's own binding of the same name
   wins.

The file holds a variable name, never the token. Ferretry's entries are recognised by that header shape
and only they are replaced: every other local-scope server, and every other key of the file, is kept.
A sign-out, or the server leaving `.mcp.json`, removes the entry at the next launch. A runtime that
**disabled** the server in that project gets no entry — somebody said no there. One that was never
asked gets it: signing in was an explicit act behind `fleet`/`configure`, and the entry runs nothing (it
is a web address). The inventory reads Ferretry's entry as that project server's delivery, not a second
server.

**Declared GAPs.**

- **Codex project servers — GAP.** Codex reads a token only from its own config, and Ferretry does not
  write a per-project override for it; a Codex row says so. Add the server to the login instead, or run
  `codex mcp login` in the ferret.
- **A Claude write between the read and the rename is lost — accepted.** Claude Code rewrites
  `.claude.json` too; the entry is written whole, beside the file and renamed over it, keeping its mode
  (the materialiser's `replaceKeys` write has the same window). What can be lost is Claude's own state,
  never a token, and the next launch writes the entry again.
- **A ferret already running does not pick up a new sign-in** until it is restarted, as for a component.

## Tests

| Property                                                                                  | Test (under `packages/daemon/tests/`)                 |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Every scope, approval, shadowing, worktrees, nothing secret on the wire, unreadable files | `unit/mcp-inventory/service.test.ts`                  |
| What each harness accepts; approval rules; JSON-RPC and SSE parsing                       | `unit/mcp-inventory/declarations.test.ts`             |
| A check: token use, no unapproved command run, env filling, redaction, the outcomes       | `unit/mcp-inventory/check.test.ts`                    |
| Project sign-in delivery: local-scope entry, variable, disabled, sign-out                 | `unit/mcp-inventory/project-sign-in.test.ts`          |
| The owner's failure end to end over real files and a fake OAuth provider                  | `integration/mcp-inventory/project-sign-in.test.ts`   |
| stdio, Streamable HTTP and SSE against fake servers; 401, 404, timeout, missing command   | `integration/mcp-inventory/probe.test.ts`             |
| The local-scope writer keeps everything else and its mode; unreadable documents           | `integration/mcp-inventory/harness-documents.test.ts` |
| Route governance and wire shapes                                                          | `unit/runtime/mounts/mcp-inventory.test.ts`           |
