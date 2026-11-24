import { describe, expect, test } from 'bun:test';
import { CreateConfigSchema, createLoosens } from '../../contract/index.ts';

const config = (patch: Record<string, unknown> = {}) => CreateConfigSchema.parse(patch);

describe('create.yaml', () => {
  test('the defaults are the owner’s decision: $5 a day, ask over $1, and no zone of its own (the host’s)', () => {
    expect(config()).toEqual({ fal: {}, elevenlabs: {}, limits: { dailyUsd: 5, askAboveUsd: 1 } });
  });

  test('only the one reference may name the key; a raw key or another secret is refused', () => {
    expect(config({ fal: { key: '${secret:FAL_KEY}' } }).fal.key).toBe('${secret:FAL_KEY}');
    expect(CreateConfigSchema.safeParse({ fal: { key: 'fal-0123456789' } }).success).toBe(false);
    expect(CreateConfigSchema.safeParse({ fal: { key: '${secret:OTHER}' } }).success).toBe(false);
  });

  test('ElevenLabs takes its own one reference too, and not fal’s', () => {
    expect(config({ elevenlabs: { key: '${secret:ELEVENLABS_API_KEY}' } }).elevenlabs.key).toBe(
      '${secret:ELEVENLABS_API_KEY}',
    );
    expect(CreateConfigSchema.safeParse({ elevenlabs: { key: 'xi-0123456789' } }).success).toBe(false);
    expect(CreateConfigSchema.safeParse({ elevenlabs: { key: '${secret:FAL_KEY}' } }).success).toBe(false);
    expect(CreateConfigSchema.safeParse({ fal: { key: '${secret:ELEVENLABS_API_KEY}' } }).success).toBe(false);
  });

  test('a limit is a positive number, the zone is a real one, and an unknown key is refused', () => {
    expect(CreateConfigSchema.safeParse({ limits: { dailyUsd: 0 } }).success).toBe(false);
    expect(CreateConfigSchema.safeParse({ limits: { askAboveUsd: -1 } }).success).toBe(false);
    expect(CreateConfigSchema.safeParse({ timeZone: 'Mars/Olympus' }).success).toBe(false);
    expect(config({ timeZone: 'America/Los_Angeles' }).timeZone).toBe('America/Los_Angeles');
    expect(CreateConfigSchema.safeParse({ limits: { weeklyUsd: 9 } }).success).toBe(false);
  });
});

describe('what loosens spend is held for the owner', () => {
  test('a higher daily limit, a higher ask threshold or another zone is held; lowering or no change is not', () => {
    const base = config();
    expect(createLoosens(base, config({ limits: { dailyUsd: 6 } }))).toHaveLength(1);
    expect(createLoosens(base, config({ limits: { askAboveUsd: 2 } }))).toHaveLength(1);
    expect(createLoosens(base, config({ timeZone: 'America/Los_Angeles' }))).toHaveLength(1);
    expect(createLoosens(base, config({ limits: { dailyUsd: 4, askAboveUsd: 0.5 } }))).toEqual([]);
    expect(createLoosens(base, base)).toEqual([]);
  });

  test('a first file is judged against the defaults', () => {
    expect(createLoosens(undefined, config({ limits: { dailyUsd: 50 } }))).toHaveLength(1);
    expect(createLoosens(undefined, config())).toEqual([]);
  });
});
