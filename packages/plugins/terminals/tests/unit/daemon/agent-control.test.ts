import { afterEach, describe, it } from 'bun:test';
import { type AgentControlKind, type AgentControlReader, agentControlRefusal } from '@ferretry/kernel/contract';
import should from 'should';
import { FERRET, type Half, terminalsHalf } from '../../support/daemon/half.ts';

/**
 * "What agents may control › Terminals" at the Terminals agent-tool boundary, read from core's `AgentControlPort`.
 * Today's `switchOf` sends every `terminal.*` tool to the `terminal` switch and refuses with `forbidden` and
 * `controlRefusal('terminal')` (rebuild-ref agent-tools/service.ts:334-343 and :436-437, policy.ts:96-101). Parity rows
 * T-0044 … T-0051 (docs/design/rebuild-parity.tsv).
 */

/** Today's sentence when Terminals is off, word for word (rebuild-ref agent-tools/policy.ts:96-101). */
const TERMINALS_OFF =
  'This machine does not let agents control terminals: "What agents may control › Terminals" is off in this machine\'s settings. Ask the person to turn it on if you need it.';

/** Each terminal tool by parity row, with an input its schema takes. */
const ROWS: readonly (readonly [string, string, Record<string, unknown>])[] = [
  ['T-0044', 'terminal_ask_owner', { name: 'dev', message: 'sign in please' }],
  ['T-0045', 'terminal_close', { name: 'dev' }],
  ['T-0046', 'terminal_list', {}],
  ['T-0047', 'terminal_open', { name: 'dev' }],
  ['T-0048', 'terminal_read', { name: 'dev' }],
  ['T-0049', 'terminal_request_input', { name: 'dev', prompt: 'Password', sensitivity: 'secret' }],
  ['T-0050', 'terminal_send', { name: 'dev', text: 'ls', keys: ['enter'] }],
  ['T-0051', 'terminal_wait', { name: 'dev', text: 'done', timeoutMs: 50 }],
];

/** The owner's switches: on for the kinds named, read afresh on each call; every ask is recorded. */
function switches(...on: AgentControlKind[]) {
  const kinds = new Set<AgentControlKind>(on);
  const asked: [string, AgentControlKind][] = [];
  const reader: AgentControlReader = {
    allows: async (who, kind) => {
      asked.push([who, kind]);
      return kinds.has(kind);
    },
  };
  return {
    reader,
    asked,
    set: (kind: AgentControlKind, value: boolean) => (value ? kinds.add(kind) : kinds.delete(kind)),
  };
}

describe('the Terminals switch ("What agents may control › Terminals", AgentControlPort)', () => {
  let half: Half | undefined;
  afterEach(async () => {
    await half?.host.stop();
    half = undefined;
  });

  for (const [row, tool, input] of ROWS)
    it(`${row} ${tool} is refused with today’s sentence while Terminals is off, and nothing runs`, async () => {
      // Arrange — every other switch on, Terminals off.
      const owner = switches('browser', 'files', 'settings', 'scripts');
      half = await terminalsHalf({}, undefined, { agentControl: owner.reader });

      // Act
      const refused = await half.host.tool(tool, input);

      // Assert
      should(refused.isError).be.true();
      should(refused.text).equal(TERMINALS_OFF);
      should(refused.text).equal(agentControlRefusal('terminal'));
      should(half.runtime.records).have.length(0);
      should(half.raised).have.length(0);
      should(owner.asked).eql([[FERRET, 'terminal']]);
    });

  it('T-0047 terminal_open runs while Terminals is on, and a switch turned off applies to the very next call', async () => {
    // Arrange
    const owner = switches('terminal');
    half = await terminalsHalf({}, undefined, { agentControl: owner.reader });

    // Act
    const opened = await half.host.tool('terminal_open', { name: 'dev' });
    owner.set('terminal', false);
    const listed = await half.host.tool('terminal_list', {});

    // Assert
    should(opened.isError).not.equal(true);
    should(half.runtime.records).have.length(1);
    should(listed.isError).be.true();
    should(listed.text).equal(TERMINALS_OFF);
  });

  it('should fail closed when Ferrets is not serving the agent-control port', async () => {
    // Arrange
    half = await terminalsHalf({}, undefined, { agentControl: null });

    // Act
    const refused = await half.host.tool('terminal_open', { name: 'dev' });

    // Assert
    should(refused.isError).be.true();
    should(refused.text).equal(TERMINALS_OFF);
    should(half.runtime.records).have.length(0);
  });

  it('should fail closed on a reader that throws or answers anything but a plain yes', async () => {
    for (const reader of [
      {
        allows: async () => {
          throw new Error('plugin_unavailable');
        },
      },
      { allows: async () => 'yes' as unknown as boolean },
    ] satisfies AgentControlReader[]) {
      // Arrange
      half = await terminalsHalf({}, undefined, { agentControl: reader });

      // Act
      const refused = await half.host.tool('terminal_open', { name: 'dev' });

      // Assert
      should(refused.isError).be.true();
      should(refused.text).equal(TERMINALS_OFF);
      should(half.runtime.records).have.length(0);
      await half.host.stop();
      half = undefined;
    }
  });

  it('should leave a person’s terminal tools route alone while Terminals is off, as today', async () => {
    // Arrange
    const owner = switches();
    half = await terminalsHalf({}, undefined, { agentControl: owner.reader });
    half.as('owner');

    // Act
    const listed = await half.host.request('POST', `/v1/ferrets/${FERRET}/surfaces/terminals/tools`, {
      body: { tool: 'terminal.list' },
    });

    // Assert
    should(listed.status).equal(200);
    should(owner.asked).eql([]);
  });
});
