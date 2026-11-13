/**
 * The built-in "Set up Ferretry" skill: what any agent needs to set a machine up through its configuration files with
 * no app at all (docs/config-files.md).
 *
 * ONE TEXT, two ways in: `fy config guide` prints it (as a `SKILL.md`, so a person can drop it into any skills
 * directory), and every agent runtime's system prompt carries its short form and points here. It names the layout, the
 * commands and the two rules that matter — no secret value in a file, and `fy config check` after every edit — and it
 * says that an edit loosening spend or authority waits for the owner, so an agent tells the owner rather than trying
 * again.
 *
 * THE FILE TABLE IS GENERATED from what the compiled plugins declare (`declaredConfig`), because in 5.0 each plugin owns
 * its own file or folder under `config/`: a table written out here would drift from the files Ferretry reads. Pure.
 */
import { claimSpelling, type DeclaredConfig, kindOf } from './declared.ts';

/** The skill's name, as a skills directory and a `/` command spell it. */
const SET_UP_FERRETRY_SKILL_NAME = 'set-up-ferretry';

function table(declared: readonly DeclaredConfig[]): string {
  if (declared.length === 0) return '_No plugin of this build declares a configuration file._';
  const rows = [...declared]
    .sort((a, b) => claimSpelling(a).localeCompare(claimSpelling(b)))
    .map(each => `| \`${claimSpelling(each)}\` | ${each.title} | \`${kindOf(each)}\` |`);
  return ['| File | Owned by | Kind (for `config schema`) |', '| --- | --- | --- |', ...rows].join('\n');
}

/** The skill, as a `SKILL.md`, for a binary called `bin` and the files these plugins declare. */
export function setUpFerretrySkill(bin: string, declared: readonly DeclaredConfig[]): string {
  return `---
name: ${SET_UP_FERRETRY_SKILL_NAME}
description: Set up or change this Ferretry machine through its configuration files. Use when asked to change a setting, add a login, a profile or a runtime, or to change what Ferretry's own features may do on this machine.
---

# Set up Ferretry

Everything this machine runs is described by YAML files. The files are the source of truth: the app,
\`${bin}\` and you are all editors of them. The daemon watches the directory, checks every file, and keeps
the last good version of a file in effect while a newer one is broken.

## Where the files are

Run \`${bin} config path\` for the directory (\`${bin} config path <file>\` for one file in it). Each plugin owns the files
it declares:

${table(declared)}

Every file starts with a \`# yaml-language-server: $schema=…\` line. \`${bin} config schema <kind>\` prints the
JSON Schema of a kind (\`${bin} config schema\` lists the kinds). \`${bin} config show <file>\` shows one file as the
daemon holds it, with its etag; a file that does not exist yet shows the starter a new one begins with.

## The commands

- \`${bin} config check\` — every file, checked as the daemon would; exits non-zero on an error. Needs no daemon.
- \`${bin} config status\` — what the daemon has in effect, every problem, every change waiting for the owner.
- \`${bin} config show <file>\` — one file: where it stands, its etag, its problems and its text.
- \`${bin} config write <file> [--if-match <etag>]\` — writes the file from standard input; refused whole unless it
  checks, and refused if the file changed since the etag.
- \`${bin} config confirm [file]\` — the owner's: puts a waiting change into effect, or lists what waits.

## The rules

1. **Never write a secret value into a file.** Store it with \`${bin} secret set NAME\` (the owner runs it and types the
   value; a ferret cannot write the secret store), then write \`\${secret:NAME}\` where the value would go. A file holding
   anything that looks like a key is refused.
2. **Run \`${bin} config check\` after every edit.** It names each problem by file, line and column, with the
   fix. A broken file is never half-applied: its last good version stays in effect until it checks.
3. **A change that loosens what the machine may spend or what agents may do waits for the owner.**
   It is written, but the tighter version stays in effect until the owner runs \`${bin} config confirm\` at
   the machine or confirms it in the app with a passkey. Tell the owner what you changed and why with an
   agenda card whose Allow confirms it: \`${bin} agenda add "<the ask>" --title "<title>" --context "<the facts around it>" --confirms <file>\`.
   Never confirm it yourself and do not try to work around it.
4. Edit only the keys you mean to change. Keep the owner's comments.

## With the Ferretry tools

When "What agents may control › Ferretry settings" is on, the \`config_read\`, \`config_validate\` and
\`config_write\` tools do the same without a shell: read the list (or one file and its etag), check a text,
and write it back with the etag you read so a newer edit is never overwritten.
`;
}
