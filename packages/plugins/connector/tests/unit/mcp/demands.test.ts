import { describe, it } from 'bun:test';
import { CAPABILITY_NAMES, type CapabilityGrants } from '@ferretry/core-gate/contract';
import should from 'should';
import {
  CONNECTOR_TOOL_NAMES,
  daemonGrantRefusal,
  TOOL_DEMANDS,
  UNDETERMINED_SENTENCE,
} from '../../../daemon/lib/mcp/demands.ts';

const grants = (overrides: Partial<Record<string, { use: boolean; configure: boolean }>> = {}): CapabilityGrants =>
  Object.fromEntries(
    CAPABILITY_NAMES.map(capability => [capability, overrides[capability] ?? { use: true, configure: true }]),
  ) as CapabilityGrants;

describe('daemonGrantRefusal', () => {
  it('allows every tool when the operator allows fleet use and configure', () => {
    for (const tool of CONNECTOR_TOOL_NAMES) should(daemonGrantRefusal(tool, grants())).be.undefined();
  });

  it('refuses every tool, in words, when the grants cannot be determined', () => {
    for (const tool of CONNECTOR_TOOL_NAMES) should(daemonGrantRefusal(tool, undefined)).equal(UNDETERMINED_SENTENCE);
  });

  it('refuses every tool when fleet.use is off, naming it', () => {
    for (const tool of CONNECTOR_TOOL_NAMES) {
      should(daemonGrantRefusal(tool, grants({ fleet: { use: false, configure: true } }))).equal(
        'The machine owner has turned off remote fleet access (fleet.use).',
      );
    }
  });

  it('does not care about axes or capabilities a tool does not demand', () => {
    should(daemonGrantRefusal('list_ferrets', grants({ fleet: { use: true, configure: false } }))).be.undefined();
    should(daemonGrantRefusal('stop_ferret', grants({ terminal: { use: false, configure: false } }))).be.undefined();
    should(daemonGrantRefusal('answer_attention', grants({ fleet: { use: true, configure: false } }))).be.undefined();
  });

  // §4.5 of the plan: 5.0's descriptors, not v4's. v4 had every tool at fleet.use.
  it('restart and spawn also demand fleet.configure, because 5.0 declares POST /v1/restarts and POST /v1/ferrets there', () => {
    const narrowed = grants({ fleet: { use: true, configure: false } });
    for (const tool of ['restart_ferret', 'spawn_ferret'] as const)
      should(daemonGrantRefusal(tool, narrowed)).equal(
        'The machine owner has turned off remote fleet access (fleet.configure), which this needs.',
      );
    for (const tool of CONNECTOR_TOOL_NAMES.filter(name => name !== 'restart_ferret' && name !== 'spawn_ferret'))
      should(daemonGrantRefusal(tool, narrowed)).be.undefined();
  });

  it('demands a declared capability on top of fleet.use when the table says so', () => {
    const table = TOOL_DEMANDS as unknown as Record<string, { capability: string; axis: string }[]>;
    const before = table.get_ferret_output;
    table.get_ferret_output = [
      { capability: 'fleet', axis: 'use' },
      { capability: 'terminal', axis: 'use' },
    ];
    try {
      should(daemonGrantRefusal('get_ferret_output', grants({ terminal: { use: false, configure: true } }))).equal(
        'The machine owner has turned off remote terminal access (terminal.use), which this needs.',
      );
      should(daemonGrantRefusal('get_ferret_output', grants())).be.undefined();
    } finally {
      table.get_ferret_output = before as { capability: string; axis: string }[];
    }
  });

  it('has a row for every tool, each demanding fleet.use', () => {
    should(Object.keys(TOOL_DEMANDS).sort()).eql([...CONNECTOR_TOOL_NAMES].sort());
    for (const tool of CONNECTOR_TOOL_NAMES)
      should(TOOL_DEMANDS[tool]).containEql({ capability: 'fleet', axis: 'use' });
  });
});
