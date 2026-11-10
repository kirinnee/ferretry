import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { operatorRefusal } from '../../../worker/src/adapters/operator-auth.ts';

const REPO = new URL('../../../../../../', import.meta.url).pathname;
const WORKFLOW = join(REPO, '.github/workflows/relay-hosted.yaml');
const SCRIPT = join(REPO, 'scripts/validate/relay-config.sh');

const workflowText = (): string => readFileSync(WORKFLOW, 'utf8');

/** The `operator_token="$({ … } | sha256sum | awk '{print $1}')"` derivation, once per job that carries it. */
function derivationBlocks(workflow: string): string[] {
  return [...workflow.matchAll(/ *operator_token="\$\(\{\n[\s\S]*?\| awk '\{print \$1\}'\)"/gu)].map(match => match[0]);
}

/** Run one derivation exactly as the workflow writes it, with a fake Cloudflare token in its environment. */
function derive(block: string, cloudflareToken: string): string {
  const result = Bun.spawnSync(
    ['bash', '--noprofile', '--norc', '-euo', 'pipefail', '-c', `${block}\nprintf '%s' "$operator_token"`],
    {
      env: { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: cloudflareToken },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('R135 the operator bearer is sha256(prefix ‖ token), installed by the deploy', () => {
  const cloudflareToken = 'cloudflare-token-fixture-not-real';
  const expected = sha256(Buffer.concat([Buffer.from('ferretry-relay-operator-v1\0'), Buffer.from(cloudflareToken)]));

  it('R135 both jobs derive the domain-separated digest, and the deploy and the control job agree', () => {
    const blocks = derivationBlocks(workflowText());
    // The deploy job and the control job each derive it; a third copy (or only one) is a drift worth seeing.
    expect(blocks).toHaveLength(2);
    for (const block of blocks) expect(derive(block, cloudflareToken)).toBe(expected);
    // Domain separation: the digest of the bare token is a different value, so it is not what is installed.
    expect(expected).not.toBe(sha256(Buffer.from(cloudflareToken)));
    expect(expected).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('R135 the deploy installs only the digest as RELAY_OPERATOR_TOKEN, never the raw Cloudflare token', () => {
    const workflow = workflowText();
    const program = workflow.match(/'(\{RELAY_OPERATOR_TOKEN: \$token\}[^\n]*)'/u)?.[1];
    if (program === undefined) throw new Error('the deploy workflow no longer builds the secrets file');
    const result = Bun.spawnSync(['jq', '-cn', '--arg', 'token', expected, program], {
      env: { PATH: process.env.PATH },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    const secrets = result.stdout.toString();
    expect(JSON.parse(secrets)).toEqual({ RELAY_OPERATOR_TOKEN: expected });
    expect(secrets).not.toContain(cloudflareToken);
    // The digest is registered with GitHub's log masker the moment it exists, in both jobs.
    expect(workflow.match(/::add-mask::\$operator_token/gu)).toHaveLength(2);
    // Wrangler receives it through the secrets file, not as an argument or a separate `secret put` of the bearer.
    expect(workflow).toContain('--secrets-file "$RELAY_SECRETS_FILE"');
    expect(workflow).not.toMatch(/wrangler secret put RELAY_OPERATOR_TOKEN/u);
  });

  it('R135 the Worker accepts the derived bearer and refuses the raw token', () => {
    const accepts = new Request('https://relay.invalid/v1/operator/config', {
      headers: { Authorization: `Bearer ${expected}` },
    });
    expect(operatorRefusal(accepts, expected)).toBeNull();
    const raw = new Request('https://relay.invalid/v1/operator/config', {
      headers: { Authorization: `Bearer ${cloudflareToken}` },
    });
    expect(operatorRefusal(raw, expected)?.status).toBe(401);
    expect(operatorRefusal(raw, undefined)?.status).toBe(503);
  });
});

// A scratch git tree holding exactly what relay-config.sh reads, so a mutation never touches the real checkout.
const SCRIPT_INPUTS = [
  '.github/workflows',
  'scripts/ci',
  'scripts/release/compile.sh',
  'scripts/local/setup.sh',
  'packages/plugins/connections/worker',
  'packages/plugins/connections/contract',
  'packages/plugins/catalogs/worker',
];

function fixtureTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'relay-config-'));
  const skip = (source: string): boolean => !source.includes('node_modules');
  for (const input of SCRIPT_INPUTS) {
    mkdirSync(dirname(join(root, input)), { recursive: true });
    cpSync(join(REPO, input), join(root, input), { recursive: true, filter: skip });
  }
  for (const group of ['packages', 'packages/core', 'packages/plugins']) {
    for (const entry of new Bun.Glob('*/package.json').scanSync({ cwd: join(REPO, group) })) {
      mkdirSync(dirname(join(root, group, entry)), { recursive: true });
      cpSync(join(REPO, group, entry), join(root, group, entry));
    }
  }
  expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root }).exitCode).toBe(0);
  return root;
}

function runScript(root: string): { code: number; out: string } {
  const result = Bun.spawnSync(['bash', SCRIPT], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}` };
}

describe('R137 relay-config.sh refuses link-store Worker name drift', () => {
  const storeConfig = 'packages/plugins/catalogs/worker/wrangler.link-store.hosted.json';
  const hostedConfig = 'packages/plugins/connections/worker/wrangler.hosted.json';

  function withTree(mutate: (root: string) => void): { code: number; out: string } {
    const root = fixtureTree();
    try {
      mutate(root);
      return runScript(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('R137 the unmodified tree passes (so the refusals below come from the drift, not the fixture)', () => {
    const { code, out } = withTree(() => {});
    expect(out).toContain('Hosted relay deploy workflow, build routes and control-plane projections agree');
    expect(code).toBe(0);
  });

  it('R137 renaming the link-store Worker without the relay binding is refused, naming the new service', () => {
    const { code, out } = withTree(root => {
      const path = join(root, storeConfig);
      const config = JSON.parse(readFileSync(path, 'utf8')) as { name: string };
      writeFileSync(path, JSON.stringify({ ...config, name: `${config.name}-renamed` }));
    });
    expect(code).not.toBe(0);
    expect(out).toContain('services must be exactly the LINK_STORE binding to the Worker named');
    expect(out).toContain('-renamed');
  });

  it('R137 renaming the relay-side service binding is refused too', () => {
    const { code, out } = withTree(root => {
      const path = join(root, hostedConfig);
      const config = readFileSync(path, 'utf8');
      const store = (JSON.parse(readFileSync(join(root, storeConfig), 'utf8')) as { name: string }).name;
      expect(config).toContain(store);
      writeFileSync(path, config.replaceAll(store, `${store}-stale`));
    });
    expect(code).not.toBe(0);
    expect(out).toContain('services must be exactly the LINK_STORE binding to the Worker named');
  });

  it('R137 a store config with no name is refused rather than binding to nothing', () => {
    const { code, out } = withTree(root => {
      const path = join(root, storeConfig);
      const { name: _name, ...rest } = JSON.parse(readFileSync(path, 'utf8')) as { name: string };
      writeFileSync(path, JSON.stringify(rest));
    });
    expect(code).not.toBe(0);
    expect(out).toContain("has no name for the relay's LINK_STORE binding to target");
  });
});

describe('R227 the relay deploy does not touch the link store', () => {
  const workflow = (): string => workflowText();
  const parsed = (): { on: { push: { paths: string[] } }; jobs: Record<string, unknown> } =>
    Bun.YAML.parse(workflow()) as never;

  it('R227 no step of the relay workflow names the link store, its config, its route or its Worker', () => {
    const text = workflow();
    expect(text).not.toMatch(/link[-_ ]?store/iu);
    expect(text).not.toContain('wrangler.link-store');
    expect(text).not.toContain('/v1/operator/link-store');
    expect(text).not.toContain('/v1/link-store');
    expect(text).not.toContain('plugins/catalogs');
  });

  it('R227 every wrangler call deploys or sets secrets against the relay config only', () => {
    const calls = workflow()
      .split('\n')
      .filter(line => !line.trim().startsWith('#'))
      .filter(line => /\bwrangler (deploy|secret|publish|delete|versions|rollback)/u.test(line));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const line of calls) expect(line).toContain('--config wrangler.hosted.json');
    // `--secrets-file` rides the relay deploy; its content is the operator bearer (+ the pool), nothing for the store.
    expect(workflow()).toContain('--config wrangler.hosted.json --tag "$RELAY_BUNDLE"');
  });

  it('R227 the deploy runs on changes to the relay package only, so a store change cannot trigger it', () => {
    const paths = parsed().on.push.paths;
    expect(paths).toContain('packages/plugins/connections/**');
    expect(paths.filter(path => path.includes('catalogs') || /link/iu.test(path))).toEqual([]);
  });

  it('R227 the store has its own workflow, started only by an operator, which the relay deploy never calls', () => {
    const store = Bun.YAML.parse(readFileSync(join(REPO, '.github/workflows/link-store-hosted.yaml'), 'utf8')) as {
      on: Record<string, unknown>;
    };
    expect(Object.keys(store.on)).toEqual(['workflow_dispatch']);
    expect(workflow()).not.toContain('link-store-hosted');
  });

  it('R227 relay-config.sh pins the store deploy as manual-only and the relay workflow stays on its own config', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain('must trigger on workflow_dispatch and nothing else');
    expect(script).toContain('--config wrangler.hosted.json\' "${workflow}"');
    expect(script).toContain('--config wrangler.link-store.hosted.json');
  });
});
