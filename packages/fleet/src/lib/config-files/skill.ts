/**
 * The built-in "Set up Ferretry" skill: what any agent needs to set a machine up through its
 * configuration files with no app at all (docs/config-files.md).
 *
 * ONE TEXT, three ways in: `fy config guide` prints it (as a `SKILL.md`, so a person can drop it into
 * any skills directory), the Ferretry tools MCP server every agent runtime starts hands it over as its
 * instructions, and the design note links it. It names the layout, the schemas, the commands and the
 * two rules that matter — no secret value in a file, and `fy config check` after every edit — and it
 * says that an edit loosening spend or authority waits for the owner, so an agent tells the owner
 * rather than trying again.
 *
 * Pure: a constant, with the binary's name filled in by the caller.
 */

/** The skill's name, as a skills directory and a `/` command spell it. */
export const SET_UP_FERRETRY_SKILL_NAME = 'set-up-ferretry';

/** The skill, as a `SKILL.md`, for a binary called `bin`. */
export function setUpFerretrySkill(bin: string): string {
  return `---
name: ${SET_UP_FERRETRY_SKILL_NAME}
description: Set up or change this Ferretry machine through its configuration files — logins, components (MCP servers, skills, instructions, settings, hooks, model sets), profiles, runtimes, the Warden, Learning and Voice. Use when asked to add an MCP server, a login, a profile or a runtime, or to change Warden, Learning or Voice settings.
---

# Set up Ferretry

Everything this machine runs is described by YAML files. The files are the source of truth: the app,
\`${bin}\` and you are all editors of them. The daemon watches the directory, checks every file, and keeps
the last good version of a file in effect while a newer one is broken.

## Where the files are

Run \`${bin} config path\` for the directory. Inside it:

| File | What it holds |
| --- | --- |
| \`machine.yaml\` | agent permissions, the default runtime, what agents may control, browser mode, auto-resume after restart (\`autoResume\`, on by default), the Attention check (\`attentionNudge\`, on by default: a ferret whose reply asks the owner to act without raising an item is reminded once), Agenda mode for new ferrets (\`agendaMode\`, on by default; a ferret's own recorded switch wins), conversations (\`listComputer\`: Continue also lists this computer's own Claude Code and Codex history), advanced settings |
| \`logins/<id>.yaml\` | one login: \`harness\`, \`store\` (\`host\`, \`ferretry\` or \`environment\`), \`env\` |
| \`components/<kind>/<name>.yaml\` | one component; kind is \`instructions\`, \`mcp\`, \`skills\`, \`settings\`, \`hooks\` or \`modelSets\` |
| \`profiles/<name>.yaml\` | \`contents:\` — components and other profiles (\`mcp/github\`, \`profile/base\`), in order; a later entry overrides an earlier one |
| \`runtimes/<name>.yaml\` | one runtime: \`credential\` (a login id), \`profile\`, \`agent: true\` for one Ferretry launches |
| \`warden.yaml\` | the Warden: \`enabled\`, \`layers\` (\`jev\` and \`llm\`, each on or off), \`caps\`, \`mayActAlone\`, \`intervalMinutes\`, \`accounts\`, … |
| \`learning.yaml\` | lesson mining |
| \`voice.yaml\` | who cleans up dictated text: \`postProcessing\`: \`provider\` (\`off\`, \`groq\`, \`cerebras\`, \`login\`), \`style\` (\`off\`, \`fix\`, \`polish\`), your own \`prompts\` for each style, \`useConversation\` and \`conversationMessages\` |
| \`pack.yaml\` | Pack mode: \`enabled\`, \`decision\` (\`agent\` or \`jev\`), \`limits\` (\`interactiveChildren\`, \`autoChildren\`, \`maxDepth\`), \`probe\`, \`jev\` |
| \`models-guide.yaml\` | the routing prompt: \`prompt\` — plain words, at most 1,200 characters, naming model ids in the order to try them (\`fy guide clean-up\` rewrites a rough one) |

Every file starts with a \`# yaml-language-server: $schema=…\` line. \`${bin} config schema <kind>\` prints the
JSON Schema of a kind (\`${bin} config schema\` lists the kinds).

## The rules

1. **Never write a secret value into a file.** Store it with \`${bin} secret set NAME\` (the owner types the
   value), then write \`\${secret:NAME}\` where the value would go. A file holding anything that looks like a
   key is refused.
2. **Run \`${bin} config check\` after every edit.** It names each problem by file, line and column, with the
   fix. (\`${bin} config write <file>\` writes from stdin through the daemon and refuses a file that does not check.) A broken file is never half-applied: its last good version stays in effect until it checks.
3. **A change that loosens what the machine may spend or what agents may do waits for the owner** —
   switching on a Warden layer that spends (\`jev\` or \`llm\`), raising a cap, letting the Warden act alone, letting agents control more, sending dictated text to a provider.
   It is written, but the tighter version stays in effect until the owner runs \`${bin} config confirm\` at
   the machine or confirms it in the app with a passkey. Tell the owner what you changed and why; do not
   try to work around it.
4. Edit only the keys you mean to change. Keep the owner's comments.

## With the Ferretry tools

When "What agents may control › Ferretry settings" is on, the \`config_read\`, \`config_validate\` and
\`config_write\` tools do the same without a shell: read the list (or one file and its etag), check a text,
and write it back with the etag you read so a newer edit is never overwritten.

## Examples

An MCP server, added to a profile:

\`\`\`yaml
# components/mcp/github.yaml
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

A login that points Claude Code at another provider:

\`\`\`yaml
# logins/glm.yaml
harness: claude
store: environment
env:
  ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic
  ANTHROPIC_AUTH_TOKEN: \${secret:GLM_API_KEY}
\`\`\`
`;
}
