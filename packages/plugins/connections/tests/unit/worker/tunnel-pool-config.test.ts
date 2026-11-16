/**
 * HOW THE TUNNEL POOL REACHES THE WORKER (`docs/cloudflare-tunnel-pool.md`, `docs/relay-protocol.md` §15): static reads
 * of `.github/workflows/relay-hosted.yaml`. The pool is a list of Cloudflare API tokens, so R654 holds that it travels
 * only through the environment and a pipe's stdin (never an argument, a file in the repo or a log line), and R655 holds
 * that the deploy's secrets file is ADDITIVE (an unset pool installs nothing and the Worker keeps the pool it has).
 *
 * WHICH HALF RUNS WHERE. These are the Linux halves: they read the workflow as text and run the exact jq program it
 * runs. The other half, a real `wrangler secret put` against a real Cloudflare account, only exists in the deploy
 * workflow on the protected `main` run, and no test here pretends to do it.
 */
import { describe, expect } from 'bun:test';
import { guarantee } from '../../support/guarantee.ts';

const POOL = 'HOSTED_TUNNEL_ACCOUNTS';

const read = async (relative: string): Promise<string> => await Bun.file(new URL(relative, import.meta.url)).text();
const workflowText = async (): Promise<string> => await read('../../../../../../.github/workflows/relay-hosted.yaml');

/** A line that EXPANDS the pool's value (a message that merely names the secret expands nothing). */
const EXPANDS = /\$\{?HOSTED_TUNNEL_ACCOUNTS|(?:secrets|env)\.HOSTED_TUNNEL_ACCOUNTS/u;

/** The expansions of the pool a workflow may make: anything else could put the value where it can be seen. */
const ALLOWED: readonly RegExp[] = [
  // The GitHub secret becomes an environment variable of exactly one step each.
  /^\s*HOSTED_TUNNEL_ACCOUNTS: \$\{\{ secrets\.HOSTED_TUNNEL_ACCOUNTS \}\}\s*$/u,
  // The blank check reads the variable, never prints it.
  /^\s*if \[\[ -z "\$\{HOSTED_TUNNEL_ACCOUNTS\}" \]\]; then\s*$/u,
  // jq reads it from ITS environment, with its own error output discarded.
  /env\.HOSTED_TUNNEL_ACCOUNTS/u,
  // The only place the value is expanded: a shell builtin into Wrangler's stdin.
  /^\s*printf "%s" "\$HOSTED_TUNNEL_ACCOUNTS" \| wrangler secret put TUNNEL_ACCOUNTS --config wrangler\.hosted\.json\s*$/u,
];

/** Every non-comment line that names the pool and is none of the allowed shapes. */
function poolLeaks(workflow: string): string[] {
  return workflow
    .split('\n')
    .filter(line => EXPANDS.test(line) && !line.trim().startsWith('#'))
    .filter(line => !ALLOWED.some(allowed => allowed.test(line)));
}

describe('the tunnel pool secret in the hosted workflow', () => {
  guarantee(
    ['R654'],
    'should hand the pool to Wrangler through the environment and stdin only, never an argument',
    async () => {
      const workflow = await workflowText();
      // The real workflow names the pool only in the allowed shapes, and both jobs that use it use all of them.
      expect(poolLeaks(workflow)).toEqual([]);
      expect(
        workflow.match(/printf "%s" "\$HOSTED_TUNNEL_ACCOUNTS" \| wrangler secret put TUNNEL_ACCOUNTS/gu),
      ).toHaveLength(1);
      expect(workflow.match(/env\.HOSTED_TUNNEL_ACCOUNTS/gu)?.length).toBeGreaterThanOrEqual(2);
      // The installing step discards jq's own error output: a parse error quotes the text around the fault.
      expect(workflow).toContain(
        'if ! jq -en \'env.HOSTED_TUNNEL_ACCOUNTS | fromjson | type == "array"\' >/dev/null 2>&1; then',
      );
      // No step traces its commands or echoes a request: either would print the value into a log anybody can read.
      const code = workflow
        .split('\n')
        .filter(line => !line.trim().startsWith('#'))
        .join('\n');
      expect(code).not.toMatch(/set -[a-z]*x/u);
      expect(code).not.toMatch(/curl[^\n]* -v\b|--verbose/u);
    },
  );

  guarantee(['R654'], 'should flag every way the pool could leak (the check is not vacuous)', () => {
    const leaking = [
      '          echo "pool is $HOSTED_TUNNEL_ACCOUNTS"',
      '          jq -n --arg pool "$HOSTED_TUNNEL_ACCOUNTS" \'{TUNNEL_ACCOUNTS: $pool}\'',
      '          wrangler secret put TUNNEL_ACCOUNTS "$HOSTED_TUNNEL_ACCOUNTS" --config wrangler.hosted.json',
      '          printf "%s" "$HOSTED_TUNNEL_ACCOUNTS" > pool.json',
      '          curl --data "$HOSTED_TUNNEL_ACCOUNTS" https://api.example/v1',
    ];
    for (const line of leaking) expect(poolLeaks(line)).toEqual([line]);
    // A comment may name it, and the allowed shapes pass.
    expect(poolLeaks('# HOSTED_TUNNEL_ACCOUNTS is the source of truth')).toEqual([]);
    expect(poolLeaks('          HOSTED_TUNNEL_ACCOUNTS: ${{ secrets.HOSTED_TUNNEL_ACCOUNTS }}')).toEqual([]);
  });

  guarantee(
    ['R654'],
    'should keep the pool out of every file the repo ships and the Worker configuration',
    async () => {
      // Neither Wrangler configuration carries the secret (a `vars` entry would be committed in clear text).
      for (const file of ['../../../worker/wrangler.hosted.json', '../../../worker/wrangler.jsonc']) {
        const config = await read(file);
        expect(config.length).toBeGreaterThan(0);
        expect(config).not.toContain('TUNNEL_ACCOUNTS');
        expect(config).not.toContain(POOL);
      }
    },
  );

  guarantee(
    ['R655'],
    'should leave TUNNEL_ACCOUNTS out of the deploy secrets file when the pool secret is unset',
    async () => {
      const workflow = await workflowText();
      const program = workflow.match(/'(\{RELAY_OPERATOR_TOKEN: \$token\}[^']*)'/u)?.[1];
      if (program === undefined) throw new Error('the hosted workflow no longer builds a deploy secrets file');
      const run = (pool: string | undefined): string => {
        const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
        if (pool !== undefined) env[POOL] = pool;
        const result = Bun.spawnSync(['jq', '-cn', '--arg', 'token', 't', program], { env });
        expect(result.exitCode).toBe(0);
        return result.stdout.toString().trim();
      };
      // Additive: a secrets file that names only the operator bearer installs nothing else and deletes nothing, so the
      // Worker keeps the pool it already holds. A blank secret is the same as an unset one.
      expect(run(undefined)).toBe('{"RELAY_OPERATOR_TOKEN":"t"}');
      expect(run('')).toBe('{"RELAY_OPERATOR_TOKEN":"t"}');
      expect(run('[{"name":"pool-1"}]')).toBe(
        '{"RELAY_OPERATOR_TOKEN":"t","TUNNEL_ACCOUNTS":"[{\\"name\\":\\"pool-1\\"}]"}',
      );
      // The file reaches Wrangler as a secrets file on the deploy, and nothing in the workflow deletes a secret.
      expect(workflow).toContain('--secrets-file "$RELAY_SECRETS_FILE"');
      expect(workflow).not.toMatch(/wrangler secret (delete|bulk)/u);
    },
  );

  guarantee(
    ['R655'],
    'should refuse a pool that is not a JSON array before anything is written, saying only that',
    async () => {
      const workflow = await workflowText();
      const install = workflow.slice(workflow.indexOf('Install the tunnel pool secret'));
      // The check comes before the put, exits non-zero, and its sentence names no value.
      const check = install.indexOf('fromjson | type == "array"');
      const put = install.indexOf('wrangler secret put TUNNEL_ACCOUNTS');
      expect(check).toBeGreaterThan(-1);
      expect(put).toBeGreaterThan(check);
      expect(install.slice(check, put)).toContain('HOSTED_TUNNEL_ACCOUNTS is not a JSON array; nothing was changed');
      expect(install.slice(check, put)).toContain('exit 1');
      // The bad value is a shape the check really rejects: run the same jq over three values that are not arrays.
      for (const bad of ['{"a":1}', '"text"', 'not json']) {
        const result = Bun.spawnSync(['jq', '-en', 'env.HOSTED_TUNNEL_ACCOUNTS | fromjson | type == "array"'], {
          env: { PATH: process.env.PATH ?? '', [POOL]: bad },
        });
        expect(result.stdout.toString().trim() === 'true').toBe(false);
      }
    },
  );
});
