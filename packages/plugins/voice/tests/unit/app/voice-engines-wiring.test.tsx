import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { voiceBuild } from '../../../app/vite-voice.ts';
import { voiceSurfaces } from '../../../app/surfaces.tsx';
import { type Mounted, mount } from '../../support/app/dom.ts';

/**
 * Settings › Voice on 5.0 said "This copy of Ferretry was built without the on-device speech engine" for every
 * engine, because the page's one voice store was built with no speech assets. These pin that the build's worker and
 * binary URLs reach the store, that the app half passes them, and that the build emits them.
 */

const BUILT_WITHOUT = 'built without the on-device speech engine';
const client = { call: async () => ({}) } as never;

const assets = {
  workerUrl: '/assets/parakeet-worker-aaaa.js',
  runtimeUrl: '/assets/ort-wasm-simd-threaded-bbbb.wasm',
  sherpa: { workerUrl: '/assets/sherpa-worker-cccc.js', runtimeUrl: '/assets/asr-dddd.wasm' },
  vosk: { workerUrl: '/assets/vosk-worker-eeee.js', runtimeUrl: '/assets/vosk-ffff.wasm' },
  whisper: { workerUrl: '/assets/whisper-worker-gggg.js', runtimeUrl: '/assets/ort-wasm-simd-threaded-bbbb.wasm' },
};

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const drawVoiceTab = async (options?: Parameters<typeof voiceSurfaces>[1]): Promise<string> => {
  const { VoiceTab } = voiceSurfaces(client, options);
  mounted = await mount(<VoiceTab />);
  // The voices read what is installed once the page mounts; give that its turns.
  for (let turn = 0; turn < 20; turn += 1) await act(async () => new Promise<void>(resolve => setTimeout(resolve, 0)));
  return mounted.container.textContent ?? '';
};

describe('Settings › Voice with the build’s speech assets', () => {
  test('an on-device engine is offered, not "built without"', async () => {
    const text = await drawVoiceTab({ speechAssets: assets });
    expect(text).not.toContain(BUILT_WITHOUT);
    expect(text).toContain('Parakeet');
  });

  test('assets loaded when the page first needs a voice are the store’s too', async () => {
    const text = await drawVoiceTab({ loadSpeechAssets: async () => assets });
    expect(text).not.toContain(BUILT_WITHOUT);
    expect(text).toContain('Parakeet');
  });

  test('a load that fails leaves the engines reading "built without" and says why', async () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => void warned.push(parts.join(' '));
    try {
      const text = await drawVoiceTab({
        loadSpeechAssets: async () => {
          throw new Error('no such chunk');
        },
      });
      expect(text).toContain(BUILT_WITHOUT);
    } finally {
      console.warn = original;
    }
    expect(warned.join('\n')).toContain('no such chunk');
  });

  test('a page given no assets still says so, for every engine', async () => {
    expect(await drawVoiceTab()).toContain(BUILT_WITHOUT);
  });

  test('"Read replies aloud" is drawn once', async () => {
    const { VoiceTab } = voiceSurfaces(client, { speechAssets: assets });
    mounted = await mount(<VoiceTab />);
    const sections = mounted.container.querySelectorAll('[data-auto-read-settings]');
    expect(sections.length).toBe(1);
  });
});

describe('the Voice app half in the built app', () => {
  const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

  test('index.ts loads the bundler-resolved assets lazily and hands them to the surfaces', () => {
    const index = source('../../../app/index.ts');
    expect(index).toContain("import('./speech-assets.ts')");
    expect(index).toContain('loadSpeechAssets');
  });

  test('speech-assets.ts binds the worker and binary of all five engines', () => {
    const file = source('../../../app/speech-assets.ts');
    for (const worker of ['parakeet', 'sherpa', 'vosk', 'whisper'])
      expect(file).toContain(`./worker/${worker}-worker.ts?worker&url`);
    for (const binary of ['sherpa-runtime-wasm?url', 'vosk.wasm?url', 'ort-wasm-simd-threaded.wasm?url'])
      expect(file).toContain(binary);
    for (const key of ['workerUrl', 'runtimeUrl', 'sherpa:', 'vosk:', 'whisper:']) expect(file).toContain(key);
  });

  test('the shell’s Vite config takes the speech workers and resolutions from Voice', () => {
    const config = source('../../../../../app/vite.config.ts');
    expect(config).toContain('worker: voiceBuild.worker');
    expect(config).toContain('alias: voiceBuild.alias');
  });

  test('the worker build is ES modules with the eval-free Vosk glue; the aliases name the sherpa loader and binary', () => {
    expect(voiceBuild.worker.format).toBe('es');
    expect(voiceBuild.worker.plugins().map(plugin => plugin.name)).toEqual(['fy-vosk-eval-free-glue']);
    const replacements = voiceBuild.alias.map(entry => entry.replacement);
    expect(replacements).toContain('onnxruntime-web/wasm');
    expect(replacements.some(path => path.endsWith('/prebuilt/asr.wasm'))).toBe(true);
    expect(replacements.some(path => /\/asr-[A-Za-z0-9_-]+\.js$/u.test(path))).toBe(true);
    const aliased = (id: string) => voiceBuild.alias.find(entry => entry.find.test(id))?.replacement;
    expect(aliased('onnxruntime-web')).toBe('onnxruntime-web/wasm');
    expect(aliased('onnxruntime-web/webgpu')).toBe('onnxruntime-web/wasm');
    expect(aliased('onnxruntime-web/ort-wasm-simd-threaded.wasm')).toBeUndefined();
  });
});
