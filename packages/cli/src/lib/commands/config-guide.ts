/**
 * The built-in "Set up Ferretry" skill, as `fy config guide` prints it: a `SKILL.md` a person can drop into any skills
 * directory, and what every agent runtime's short instruction points at (docs/config-files.md "Agents").
 *
 * It teaches the rules and the commands, and leaves the LAYOUT to the daemon: which files exist, what kind each is and
 * which schema checks it is `config status` and `config schema`, so this text never goes stale with a plugin that adds
 * or renames a file. Pure: a constant, with the binary's name filled in.
 */

/** The skill's name, as a skills directory and a `/` command spell it. */
const SET_UP_FERRETRY_SKILL_NAME = 'set-up-ferretry';

/** The skill, as a `SKILL.md`, for a binary called `bin`. */
export function setUpFerretrySkill(bin: string): string {
  return `---
name: ${SET_UP_FERRETRY_SKILL_NAME}
description: Set up or change this Ferretry machine through its configuration files — logins, MCP servers, skills, instructions, settings, hooks, model sets, profiles, runtimes, the Warden, Learning and Voice. Use when asked to add an MCP server, a login, a profile or a runtime, or to change a Ferretry setting.
---

# Set up Ferretry

Everything this machine runs is described by YAML files. The files are the source of truth: the app, \`${bin}\` and you
are all editors of them. The daemon watches the directory, checks every file, and keeps the last good version of a file
in effect while a newer one is broken.

## Where the files are, and what each one is

- \`${bin} config path\` prints the directory (and \`${bin} config path <file>\` one file in it).
- \`${bin} config status\` lists every file the daemon has, the kind that owns it, whether it is in effect, every
  problem found and every change waiting for the owner.
- \`${bin} config schema\` lists the schemas; \`${bin} config schema <name or file>\` prints one as JSON Schema.
  Every file starts with a \`# yaml-language-server: $schema=…\` line naming its own.
- \`${bin} config show <file>\` prints one file as the daemon holds it, with its etag.

A file is one of: a single document at the top (\`warden.yaml\`, \`voice.yaml\`, …), or one item of a folder
(\`logins/<id>.yaml\`, \`profiles/<name>.yaml\`, \`runtimes/<name>.yaml\`, \`mcp/<name>.yaml\`, \`skills/<name>.yaml\`,
\`claude-code/settings/<name>.yaml\`, …). A profile's \`contents:\` names components (\`mcp/github\`, \`instructions/main\`) and other
profiles (\`profile/base\`), in order; a later entry overrides an earlier one. A runtime is one login plus one profile.

## The rules

1. **Never write a secret value into a file.** Store it with \`${bin} secret set NAME\` (the owner runs it and types the
   value; a ferret cannot write the secret store), then write \`\${secret:NAME}\` where the value would go. A file holding
   anything that looks like a key is refused, and a value shown as \`‹hidden›\` is kept as it is unless you change it.
2. **Run \`${bin} config check\` after every edit.** It names each problem by file, line and column, with the fix, and
   exits non-zero on an error. A broken file is never half-applied: its last good version stays in effect until the new
   one checks.
3. **A change that loosens what the machine may spend or what agents may do waits for the owner** — turning on a Warden
   layer that spends, raising a cap, letting the Warden act alone, letting agents control more, opening the public usage
   feed, sending dictated text to a provider. It is written, but the tighter version stays in effect until the owner
   runs \`${bin} config confirm <file>\` at the machine or confirms it in the app with a passkey. Tell the owner what you
   changed and why; never confirm it yourself and do not try to work around it.
4. Edit only the keys you mean to change, and keep the owner's comments.

## Writing a file

- By hand: edit the file, then \`${bin} config check\`.
- Through the daemon: \`${bin} config show <file>\` for the etag, then
  \`${bin} config write <file> --if-match <etag> < new.yaml\`. It is refused whole unless it checks, and refused if the file
  moved since the etag.
- One item of a component folder: \`${bin} mcp add|edit|rm <name>\` and \`${bin} harness claude-code|codex settings|hooks
  add|edit|rm <name>\` do the same, and \`ls\` and \`show\` read.

## With the Ferretry tools

When "What agents may control › Ferretry settings" is on, the \`config_read\`, \`config_validate\` and \`config_write\`
tools do the same without a shell: read the list (or one file and its etag), check a text, and write it back with the
etag you read so a newer edit is never overwritten.

## Examples

An MCP server, added to a profile:

\`\`\`yaml
# mcp/github.yaml
command: github-mcp-server
args: [stdio]
env:
  GITHUB_TOKEN: \${secret:GITHUB_TOKEN}
\`\`\`

\`\`\`yaml
# profiles/default.yaml
contents:
  - instructions/main
  - mcp/github
\`\`\`

For any other kind, \`${bin} config schema <name>\` shows exactly which keys a file takes.
`;
}
