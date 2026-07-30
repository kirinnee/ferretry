import type { ProbeDefinition } from './contracts.ts';
import { defineGate, defineSmoke } from './definition.ts';
import { expectGreen, expectRed } from './helpers.ts';

const sandbox = { snapshot: 'git' as const, preserve: ['.direnv'] };

export interface Mutation {
  readonly path: string;
  readonly find: string;
  readonly replace: string;
}

export function staticGate(name: string, contract: string, mutation: Mutation): ProbeDefinition {
  const command = `nix develop .#ci -c ./scripts/validate/cli-contracts.sh ${contract}`;
  return defineGate({
    sandbox,
    baseline: {
      name: `baseline-${name}-green`,
      description: `The ${name} contract passes its own validator.`,
      async run(repo) {
        await expectGreen(repo, command, name);
      },
    },
    mutation: {
      name: `mutation-${name}-caught`,
      description: `A focused ${name} contract violation turns its validator red.`,
      expectedImpact: [],
      async run(repo) {
        await repo.patch(mutation.path, { find: mutation.find, replace: mutation.replace });
        await expectRed(repo, command, name);
      },
    },
  });
}

export function commandSmoke(name: string, command: string): ProbeDefinition {
  return defineSmoke({
    sandbox,
    baseline: {
      name: `baseline-${name}-green`,
      description: `The ${name} operation completes successfully.`,
      async run(repo) {
        await expectGreen(repo, command, name);
      },
    },
  });
}
