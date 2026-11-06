import { describe, expect, test } from 'bun:test';
import { VOICE_SLICE, voiceScopeName } from '../../../src/lib/cgroups/scope.ts';
import { FLEET_SLICE } from '../../../src/lib/cgroups/scope.ts';
import { planVoiceLaunch } from '../../../src/lib/voice/placement.ts';
import {
  describeVoice,
  voiceCores,
  voiceMemoryLimit,
  voicePlacementSupport,
  voiceUnitLimits,
  voiceWorkerCommand,
  voiceWorkerThreads,
} from '../../../src/lib/voice/policy.ts';
import { answerArguments, daemonUsageText } from '../../../src/lib/runtime/arguments.ts';

const host = { platform: 'linux', unifiedHierarchy: true, cpus: 32, memoryBytes: 32 * 1024 ** 3 };
const recognizer = {
  modelId: 'fake',
  modelBytes: 487_170_055,
  peakResidentBytes: 1024 ** 3,
  streaming: false,
  threads: 4,
};
const command = ['/bin/fyd', 'voice-worker'];
describe('voice placement', () => {
  test('C is floor(cores/4), clamped to 1 through 4', () => {
    // Arrange / Act / Assert
    expect([1, 3, 4, 7, 8, 12, 16, 32, 128].map(voiceCores)).toEqual([1, 1, 1, 1, 2, 3, 4, 4, 4]);
  });
  test('memory floor and peak factor cover heavier chooser models', () => {
    // Arrange / Act / Assert
    expect(voiceMemoryLimit([recognizer])).toBe(1_500_000_000);
    expect(voiceMemoryLimit([{ ...recognizer, peakResidentBytes: 2_000_000_001 }])).toBe(2_500_000_002);
  });
  test('weight is on the sibling slice; quota and memory are on the scope, through shared helpers', async () => {
    // Arrange
    const calls: (readonly string[])[] = [];
    // Act
    const actual = await planVoiceLaunch({
      host,
      recognizers: [recognizer],
      command,
      nonce: 'once !',
      commands: {
        execute: async argv => {
          calls.push(argv);
          return { code: 0, stdout: '', stderr: '' };
        },
      },
    });
    // Assert
    expect(VOICE_SLICE.replace('-voice.slice', '-fleet.slice')).toBe(FLEET_SLICE);
    expect(calls).toEqual([['systemctl', '--user', 'set-property', '--runtime', VOICE_SLICE, 'CPUWeight=200']]);
    expect(actual).toEqual({
      placement: { hardCapped: true },
      command: [
        'systemd-run',
        '--user',
        '--scope',
        '--quiet',
        '--collect',
        `--unit=${voiceScopeName('once !')}`,
        `--slice=${VOICE_SLICE}`,
        '--property=CPUQuota=400%',
        '--property=MemoryMax=1500000000',
        '--',
        ...command,
      ],
    });
    expect(actual.command.some(arg => arg.includes('CPUWeight'))).toBe(false);
    expect(voiceScopeName('once !')).toMatch(/-voice-once.scope$/u);
  });
  test('scope quota is C x 100% from the host cores whatever the recognizer declares', async () => {
    // Arrange
    const quotaFor = async (cpus: number, threads: number) => {
      const plan = await planVoiceLaunch({
        host: { ...host, cpus },
        recognizers: [{ ...recognizer, threads }],
        command,
        nonce: 'n',
        commands: { execute: async () => ({ code: 0, stdout: '', stderr: '' }) },
      });
      return plan.command.find(arg => arg.startsWith('--property=CPUQuota='));
    };
    // Act / Assert
    expect(await quotaFor(8, 4)).toBe('--property=CPUQuota=200%');
    expect(await quotaFor(4, 4)).toBe('--property=CPUQuota=100%');
    expect(await quotaFor(2, 4)).toBe('--property=CPUQuota=100%');
    expect(await quotaFor(16, 1)).toBe('--property=CPUQuota=400%');
    expect(await quotaFor(64, 4)).toBe('--property=CPUQuota=400%');
    expect([8, 4, 64].map(cores => voiceUnitLimits(cores, [{ ...recognizer, threads: 4 }]).cpuQuota)).toEqual([
      '200%',
      '100%',
      '400%',
    ]);
  });
  test('worker threads never exceed the host budget C', () => {
    // Arrange / Act / Assert
    expect(voiceWorkerThreads(8, [{ ...recognizer, threads: 4 }])).toBe(2);
    expect(voiceWorkerThreads(4, [{ ...recognizer, threads: 4 }])).toBe(1);
    expect(voiceWorkerThreads(64, [{ ...recognizer, threads: 4 }])).toBe(4);
    expect(voiceWorkerThreads(64, [{ ...recognizer, threads: 1 }])).toBe(1);
  });
  test('unsupported hosts keep daemon priority, run directly and disclose why', async () => {
    // Arrange / Act
    for (const machine of [
      { ...host, unifiedHierarchy: false },
      { ...host, platform: 'darwin' },
    ]) {
      const actual = await planVoiceLaunch({
        host: machine,
        recognizers: [recognizer],
        command,
        nonce: 'n',
        commands: {
          execute: async () => {
            throw new Error('must not call manager');
          },
        },
      });
      // Assert
      expect(actual.command).toBe(command);
      expect(actual.placement.hardCapped).toBe(false);
      expect(describeVoice(actual.placement)).toContain('not hard-capped:');
    }
    expect(voicePlacementSupport({ ...host, unifiedHierarchy: false })).toMatchObject({
      reason: 'cgroup v2 is unavailable',
    });
    expect(describeVoice({ hardCapped: true })).toBe('engine not installed; hard-capped yes');
  });
  test('manager refusals and missing executable become an uncapped direct plan', async () => {
    // Arrange / Act / Assert
    for (const mode of ['refused', 'throws', 'empty'] as const) {
      const actual = await planVoiceLaunch({
        host,
        recognizers: [recognizer],
        command,
        nonce: 'n',
        commands: {
          execute: async () => {
            if (mode === 'throws') throw new Error('systemctl missing');
            return { code: 1, stderr: mode === 'refused' ? 'No user manager' : '', stdout: '' };
          },
        },
      });
      expect(actual.command).toBe(command);
      expect(actual.placement).toEqual({
        hardCapped: false,
        reason:
          mode === 'refused'
            ? 'No user manager'
            : mode === 'throws'
              ? 'systemctl missing'
              : 'Could not weight speech slice.',
      });
    }
  });
  test('compiled child launches its executable; source child launches the fyd entry', () => {
    // Arrange / Act / Assert
    expect(voiceWorkerCommand('/bin/fyd', '/$bunfs/root/fyd.ts')).toEqual(['/bin/fyd', 'voice-worker']);
    expect(voiceWorkerCommand('/bin/bun', '/repo/packages/daemon/bin/fyd.ts')).toEqual([
      '/bin/bun',
      '/repo/packages/daemon/bin/fyd.ts',
      'voice-worker',
    ]);
    const usage = { daemonName: 'fyd', clientName: 'fy', version: '0.0.0' };
    expect(answerArguments(['voice-worker'], usage)).toEqual({ kind: 'voice-worker' });
    expect(answerArguments(['voice-worker', 'extra'], usage).kind).toBe('refuse');
    expect(daemonUsageText(usage)).not.toContain('voice-worker');
  });
});

test('a refused systemd-run is reaped before direct fallback, and fallback failure is propagated', async () => {
  // Arrange
  const { launchPlacedVoiceWorker } = await import('../../../src/lib/voice/placement.ts');
  const attempts: unknown[] = [];
  const handle = { placement: { hardCapped: false as const, reason: 'refused' }, send: () => {}, stop: async () => {} };
  // Act
  const actual = await launchPlacedVoiceWorker(
    { command: ['systemd-run', 'worker'], placement: { hardCapped: true } },
    command,
    async (argv, placement) => {
      attempts.push({ argv, placement });
      if (attempts.length === 1) throw new Error('scope refused');
      return handle;
    },
  );
  // Assert
  expect(actual).toBe(handle);
  expect(attempts).toEqual([
    { argv: ['systemd-run', 'worker'], placement: { hardCapped: true } },
    { argv: command, placement: { hardCapped: false, reason: 'scope refused' } },
  ]);
  expect(
    await launchPlacedVoiceWorker(
      { command, placement: { hardCapped: false, reason: 'macOS' } },
      command,
      async () => handle,
    ),
  ).toBe(handle);
  expect(await launchPlacedVoiceWorker({ command, placement: { hardCapped: true } }, command, async () => handle)).toBe(
    handle,
  );
  await expect(
    launchPlacedVoiceWorker({ command, placement: { hardCapped: true } }, command, async () => {
      throw new Error('no executable');
    }),
  ).rejects.toThrow('no executable');
});

test('two active models share one summed memory ceiling and one GiB headroom', async () => {
  // Arrange
  const { voiceMemoryAdmission } = await import('../../../src/lib/voice/policy.ts');
  const { VoiceRecognizerSetSchema } = await import('../../../src/lib/voice/ipc.ts');
  const streaming = {
    ...recognizer,
    modelId: 'stream',
    streaming: true,
    modelBytes: 200_000_000,
    peakResidentBytes: 500_000_000,
  };
  const selected = [recognizer, streaming];
  const needed = recognizer.modelBytes + streaming.modelBytes + 1024 ** 3;
  // Act / Assert
  expect(voiceMemoryLimit(selected)).toBe(
    Math.ceil((recognizer.peakResidentBytes + streaming.peakResidentBytes) * 1.25),
  );
  expect(voiceUnitLimits(host.cpus, selected).memoryMax).toBe(String(voiceMemoryLimit(selected)));
  expect(voiceMemoryAdmission(needed - 1, selected)).toMatchObject({ code: 'voice_no_memory' });
  expect(voiceMemoryAdmission(needed, selected)).toMatchObject({ ok: true });
  expect(VoiceRecognizerSetSchema.safeParse(selected).success).toBe(true);
  expect(VoiceRecognizerSetSchema.safeParse([recognizer, { ...recognizer, modelId: 'another-batch' }]).success).toBe(
    false,
  );
  expect(VoiceRecognizerSetSchema.safeParse([recognizer, { ...streaming, modelId: recognizer.modelId }]).success).toBe(
    false,
  );
});
