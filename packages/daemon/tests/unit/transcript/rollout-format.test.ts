import { describe, it } from 'bun:test';
import should from 'should';
import {
  classifyRolloutShape,
  REQUIRED_ROLLOUT_KINDS,
  rolloutShape,
} from '../../../src/lib/transcript/convert/rollout-format.ts';

const fixture = async (name: string): Promise<string> =>
  await Bun.file(new URL(`../../fixtures/transcript/convert/${name}`, import.meta.url)).text();

const line = (type: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: 't', type, payload });
const meta = {
  id: 'x',
  timestamp: 't',
  cwd: '/w',
  originator: 'o',
  cli_version: '0.1.0',
  source: 'exec',
  model_provider: 'p',
};
const message = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] };
const rollout = (...lines: readonly string[]): string => lines.join('\n');

describe('rollout format — the shape the converter depends on', () => {
  for (const version of ['0.145.0', '0.156.1', '0.163.0', '0.164.0', '0.165.0']) {
    it(`should call the rollout Codex ${version} really wrote the validated format`, async () => {
      // Arrange
      const shape = rolloutShape(await fixture(`codex-${version}.jsonl`));

      // Act + Assert
      should(classifyRolloutShape(shape, REQUIRED_ROLLOUT_KINDS)).deepEqual({ kind: 'same' });
    });
  }

  it('should not count a key Codex adds, or a record kind the converter never reads, as a difference', () => {
    // Arrange
    const shape = rolloutShape(
      rollout(
        line('session_meta', { ...meta, brand_new: 1 }),
        line('response_item', { ...message, content_item_metadata: [{ provenance: 'x' }] }),
        line('event_msg', { type: 'something_new' }),
      ),
    );

    // Act + Assert
    should(classifyRolloutShape(shape, REQUIRED_ROLLOUT_KINDS)).deepEqual({ kind: 'same' });
  });

  it('should name the record kind that went missing', () => {
    // Arrange
    const shape = rolloutShape(rollout(line('session_meta', meta)));

    // Act + Assert
    should(classifyRolloutShape(shape, REQUIRED_ROLLOUT_KINDS)).deepEqual({
      kind: 'different',
      reason: 'it no longer writes response_item/message records',
    });
  });

  it('should name the keys a record kind lost', () => {
    // Arrange
    const { cli_version: _, ...withoutVersion } = meta;
    const shape = rolloutShape(rollout(line('session_meta', withoutVersion), line('response_item', message)));

    // Act + Assert
    should(classifyRolloutShape(shape, REQUIRED_ROLLOUT_KINDS)).deepEqual({
      kind: 'different',
      reason: 'its session_meta/- records no longer carry payload.cli_version',
    });
  });

  it('should see a tool output that is a list as still carrying its output', () => {
    // Arrange
    const shape = rolloutShape(
      rollout(
        line('session_meta', meta),
        line('response_item', message),
        line('response_item', { type: 'function_call_output', call_id: 'c', output: [{ type: 'text', text: 'x' }] }),
      ),
    );

    // Act + Assert
    should(classifyRolloutShape(shape, REQUIRED_ROLLOUT_KINDS)).deepEqual({ kind: 'same' });
  });

  it('should skip lines that are not records, and read an empty rollout as having none of the kinds', () => {
    // Arrange
    const shape = rolloutShape(['', 'not json', '[1]', '{"type":3}', '{"type":"x"}'].join('\n'));

    // Act + Assert
    should([...shape.keys()]).deepEqual(['x/-']);
    should(classifyRolloutShape(rolloutShape(''), REQUIRED_ROLLOUT_KINDS).kind).equal('different');
  });
});
