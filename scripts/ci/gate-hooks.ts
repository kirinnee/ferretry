import { readFileSync } from 'node:fs';

// Discover hooks from the generated configuration rather than maintaining a second hook inventory.
const config = Bun.YAML.parse(readFileSync('.pre-commit-config.yaml', 'utf8')) as {
  repos: { hooks: { id: string; stages?: string[] }[] }[];
};
const deferred = new Set(['a-deadcode', 'a-deadcode-production']);
const mode = Bun.argv[2];
if (mode !== 'quick' && mode !== 'full') throw new Error('usage: gate-hooks.ts quick|full');
for (const repo of config.repos) {
  for (const hook of repo.hooks) {
    if (hook.id === 'treefmt' || (hook.stages !== undefined && !hook.stages.includes('pre-commit'))) continue;
    if (deferred.has(hook.id) === (mode === 'full')) console.log(hook.id);
  }
}
