import { describe, it } from 'bun:test';
import should from 'should';
import {
  humanBytes,
  installPercent,
  renderEnhancement,
  renderInstallStatus,
  renderModel,
  renderModelList,
  renderSttStatus,
  renderTranscript,
  renderWorker,
} from '../../../src/lib/stt/render';
import {
  enhancement,
  failedModel,
  installingModel,
  missingModel,
  modelList,
  readyModel,
  sttStatus,
  transcript,
} from './fixtures';

describe('byte and progress rendering', () => {
  it('should scale a byte count to a unit a human can compare', () => {
    // Act + Assert
    should(humanBytes(0)).equal('0 B');
    should(humanBytes(999)).equal('999 B');
    should(humanBytes(1_536)).equal('1.5 KiB');
    should(humanBytes(512_000_000)).equal('488.3 MiB');
    should(humanBytes(3 * 1024 ** 3)).equal('3.0 GiB');
    should(humanBytes(4096 * 1024 ** 3)).equal('4096.0 GiB');
  });

  it('should report an unknown total as unknown rather than dividing by zero', () => {
    // Act + Assert
    should(installPercent({ modelId: 'm', receivedBytes: 0, totalBytes: 0, phase: 'idle' })).equal('?%');
    should(
      installPercent({
        modelId: 'm',
        receivedBytes: 25,
        totalBytes: 100,
        phase: 'downloading',
        startedAt: '2026-07-31T09:00:00.000Z',
      }),
    ).equal('25%');
  });

  it('should name every install phase', () => {
    // Arrange
    const base = { modelId: 'm', receivedBytes: 1, totalBytes: 2, startedAt: '2026-07-31T09:00:00.000Z' };

    // Act + Assert
    should(renderInstallStatus({ ...base, phase: 'idle' })).equal('not started');
    should(renderInstallStatus({ ...base, phase: 'downloading' })).containEql('downloading 50%');
    should(renderInstallStatus({ ...base, phase: 'extracting' })).equal('extracting');
    should(renderInstallStatus({ ...base, phase: 'verifying' })).equal('verifying checksums');
    should(renderInstallStatus({ ...base, phase: 'ready', finishedAt: '2026-07-31T09:05:00.000Z' })).equal(
      'installed 2026-07-31T09:05:00.000Z',
    );
    should(
      renderInstallStatus({
        ...base,
        phase: 'failed',
        finishedAt: '2026-07-31T09:05:00.000Z',
        message: 'checksum mismatch',
        code: 'install_failed',
      }),
    ).equal('failed (install_failed): checksum mismatch');
  });
});

describe('model rendering', () => {
  it('should show what an installed model costs and that its files were verified', () => {
    // Act
    const rendered = renderModel(readyModel());

    // Assert
    should(rendered).containEql('parakeet-v3  [ready]  Parakeet v3');
    should(rendered).containEql('runs: daemon · languages: en');
    should(rendered).containEql('download 488.3 MiB');
    should(rendered).containEql('1 files verified');
  });

  it('should show an uninstalled model without pretending it has files', () => {
    // Act
    const rendered = renderModel(missingModel());

    // Assert
    should(rendered).containEql('[not-installed]');
    should(rendered).containEql('install: not started');
    should(rendered).not.containEql('verified');
  });

  it('should include a cost summary when the daemon supplies one', () => {
    // Arrange
    const annotated = { ...readyModel(), costs: { ...readyModel().costs, summary: 'about 4x realtime on this host' } };

    // Act + Assert
    should(renderModel(annotated)).containEql('about 4x realtime on this host');
  });

  it('should list the daemon model before the browser one, because only it can transcribe here', () => {
    // Act
    const lines = renderModelList(modelList()).split('\n');

    // Assert
    should(lines[0]).equal('dictation models');
    should(lines[1]).containEql('parakeet-v3');
    should(renderModelList(modelList())).containEql('whisper-tiny');
  });
});

describe('worker and status rendering', () => {
  it('should name every worker phase', () => {
    // Act + Assert
    should(renderWorker({ phase: 'cold' })).containEql('cold');
    should(renderWorker({ phase: 'loading' })).equal('worker: loading');
    should(renderWorker({ phase: 'loading', modelId: 'parakeet-v3' })).equal('worker: loading parakeet-v3');
    should(renderWorker({ phase: 'ready', pid: 7, modelId: 'm', loadedAt: '2026-07-31T09:00:00.000Z' })).containEql(
      'ready with m',
    );
    should(renderWorker({ phase: 'busy', pid: 7, modelId: 'm', loadedAt: '2026-07-31T09:00:00.000Z' })).containEql(
      'busy with m',
    );
    should(
      renderWorker({
        phase: 'error',
        lastError: { code: 'load_failed', message: 'no native runtime', at: '2026-07-31T09:00:00.000Z' },
      }),
    ).containEql('error (load_failed)');
    should(renderWorker({ phase: 'closed' })).equal('worker: closed');
  });

  it('should lead with whether dictation actually works', () => {
    // Act
    const rendered = renderSttStatus(sttStatus());

    // Assert
    should(rendered.split('\n')[0]).equal('dictation is available');
    should(rendered).containEql('16000 Hz, 1 channel, 16-bit, up to 120s');
    should(rendered).containEql('parakeet-v3');
  });

  it('should say plainly when dictation is unavailable', () => {
    // Act
    const rendered = renderSttStatus(
      sttStatus({ models: modelList(missingModel()).models, worker: { phase: 'cold' } }),
    );

    // Assert
    should(rendered.split('\n')[0]).equal('dictation is NOT available');
    should(rendered).containEql('[not-installed]');
  });
});

describe('transcript rendering', () => {
  it('should put the text alone on the first line so a pipe gets only the words', () => {
    // Act
    const lines = renderTranscript(transcript()).split('\n');

    // Assert
    should(lines[0]).equal('never install at the repository root');
    should(lines[1]).equal('— parakeet-v3: 4.0s of audio decoded in 0.8s (rtf 0.20)');
  });

  it('should report the enhancement provider alongside the cleaned text', () => {
    // Act
    const lines = renderEnhancement(enhancement()).split('\n');

    // Assert
    should(lines[0]).equal('Never install at the repository root.');
    should(lines[1]).equal('— groq/llama-3.3-70b in 320ms');
  });
});

describe('failed installs', () => {
  it('should surface the reason an install failed', () => {
    // Act + Assert
    should(renderModel(failedModel())).containEql('failed (install_failed): checksum mismatch');
    should(renderModel(installingModel())).containEql('downloading 25%');
  });
});
