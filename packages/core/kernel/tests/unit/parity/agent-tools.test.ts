/** The kernel-owned T rows of docs/design/rebuild-parity.tsv, each named by its id: the agent's three config tools. */
import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import kernel from '../../../plugin.ts';

const declared = (name: string) => kernel.actions?.agentTools?.find(candidate => candidate.name === name);
const inputOf = (name: string): z.ZodType => {
  const input = declared(name)?.input;
  if (input === undefined) throw new Error(`${name} declares no input`);
  return input as z.ZodType;
};
const TEXT = 'limit: 10\n';

describe('the agent config tools (T-0032, T-0033, T-0034)', () => {
  test('T-0032 config_read exists with v4 arguments: an optional path, nothing else, and v4 words', () => {
    const tool = declared('config_read');
    expect(tool?.summary).toBe(
      'Read this machine’s Ferretry configuration: no path: every file and problem; a path: that file’s text and etag (pass it to config_write).',
    );
    expect(inputOf('config_read').safeParse({}).success).toBe(true);
    expect(inputOf('config_read').safeParse({ path: 'machine.yaml' }).success).toBe(true);
    expect(inputOf('config_read').safeParse({ path: '' }).success).toBe(false);
    expect(inputOf('config_read').safeParse({ path: 'machine.yaml', text: TEXT }).success).toBe(false);
    expect(tool?.privilegedOnly).toBe(true);
  });

  test('T-0033 config_validate exists with v4 arguments: a path and the whole text, both required', () => {
    const tool = declared('config_validate');
    expect(tool?.summary).toBe(
      'Check a config file’s text as if it were written, without writing it. Answers each problem with its line and the fix.',
    );
    expect(inputOf('config_validate').safeParse({ path: 'voice.yaml', text: TEXT }).success).toBe(true);
    expect(inputOf('config_validate').safeParse({ path: 'voice.yaml' }).success).toBe(false);
    expect(inputOf('config_validate').safeParse({ text: TEXT }).success).toBe(false);
    expect(inputOf('config_validate').safeParse({ path: 'voice.yaml', text: TEXT, etag: 'e1' }).success).toBe(false);
    expect(tool?.privilegedOnly).toBe(true);
  });

  test('T-0034 config_write exists with v4 arguments: a path, the whole text and an optional etag; a text over 256 KiB is refused', () => {
    const tool = declared('config_write');
    expect(tool?.summary).toBe(
      'Write a config file. Refused unless it checks. A change that loosens spending or what agents may do waits for the owner to confirm; tell them.',
    );
    const write = inputOf('config_write');
    expect(write.safeParse({ path: 'voice.yaml', text: TEXT }).success).toBe(true);
    expect(write.safeParse({ path: 'voice.yaml', text: TEXT, etag: 'e1' }).success).toBe(true);
    expect(write.safeParse({ path: 'voice.yaml', text: TEXT, etag: '' }).success).toBe(false);
    expect(write.safeParse({ path: 'voice.yaml' }).success).toBe(false);
    expect(write.safeParse({ path: 'voice.yaml', text: 'x'.repeat(256 * 1024 + 1) }).success).toBe(false);
    expect(tool?.privilegedOnly).toBe(true);
  });
});
