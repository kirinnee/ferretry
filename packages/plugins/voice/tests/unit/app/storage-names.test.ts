import { describe, expect, test } from 'bun:test';
import { databaseName, localKey, speechModelCache } from '@ferretry/app';
import { ON_DEVICE_MODELS } from '../../../app/lib/stt/model-catalog.ts';
import {
  DICTATION_DEBUG_STORAGE_KEY,
  LIVE_VOICE_STORAGE_KEY,
  SPEED_MEMORY_STORAGE_KEY,
  STT_SETTINGS_STORAGE_KEY,
  VOICE_DATABASE,
} from '../../../app/lib/storage-names.ts';

describe('the browser-side names (§9.4)', () => {
  test('each is what the shell’s own name functions make for the voice id', () => {
    expect(STT_SETTINGS_STORAGE_KEY).toBe(localKey('voice', 'stt-settings'));
    expect(SPEED_MEMORY_STORAGE_KEY).toBe(localKey('voice', 'speed-memory'));
    expect(LIVE_VOICE_STORAGE_KEY).toBe(localKey('voice', 'live-settings'));
    expect(DICTATION_DEBUG_STORAGE_KEY).toBe(localKey('voice', 'dictation-debug'));
    expect(VOICE_DATABASE).toBe(databaseName('voice'));
  });

  test('every speech model’s cache is fy:voice:<model>', () => {
    for (const model of ON_DEVICE_MODELS) {
      expect(model.cache).toBe(speechModelCache(model.cache.slice('fy:voice:'.length)));
    }
  });
});
