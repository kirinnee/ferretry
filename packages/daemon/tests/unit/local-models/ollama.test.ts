import { describe, it } from 'bun:test';
import { builtInModelCatalogs } from '@ferretry/fleet';
import should from 'should';
import {
  DEFAULT_OLLAMA_URL,
  describeOllama,
  type OllamaAddress,
  ollamaAddress,
  parseOllamaTags,
  pullCommand,
  suggestedOllamaModel,
} from '../../../src/lib/local-models/ollama.ts';

const TAGS = {
  models: [
    {
      name: 'gpt-oss:20b',
      model: 'gpt-oss:20b',
      modified_at: '2025-08-06T10:12:42.123456789-07:00',
      size: 13_780_173_839,
      details: { family: 'gptoss', parameter_size: '20.9B', quantization_level: 'MXFP4' },
    },
    { name: 'llama3.2:latest', size: 2_019_393_189 },
  ],
};

const AT = '2026-10-19T00:00:00.000Z';
const OK: OllamaAddress = { ok: true, baseUrl: DEFAULT_OLLAMA_URL };

describe('ollamaAddress', () => {
  it('should read the default when nothing is set', () => {
    should(ollamaAddress(undefined)).eql({ ok: true, baseUrl: 'http://127.0.0.1:11434' });
    should(ollamaAddress('   ')).eql({ ok: true, baseUrl: 'http://127.0.0.1:11434' });
  });

  for (const [written, expected] of [
    ['127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['localhost', 'http://localhost:11434'],
    [':9999', 'http://127.0.0.1:9999'],
    ['0.0.0.0', 'http://127.0.0.1:11434'],
    ['0.0.0.0:8080', 'http://127.0.0.1:8080'],
    ['http://localhost:12345/', 'http://localhost:12345'],
    ['[::]:11434', 'http://[::1]:11434'],
    ['[::1]', 'http://[::1]:11434'],
  ] as const) {
    it(`should take OLLAMA_HOST=${written} as ${expected}`, () => {
      should(ollamaAddress(written)).eql({ ok: true, baseUrl: expected });
    });
  }

  it('should refuse an address that is not this machine, without carrying a credential into it', () => {
    should(ollamaAddress('http://user:secret@gpu-box.lan:11434')).eql({
      ok: false,
      baseUrl: 'http://gpu-box.lan:11434',
    });
    should(ollamaAddress('10.0.0.5')).eql({ ok: false, baseUrl: 'http://10.0.0.5:11434' });
    should(ollamaAddress('https://localhost:11434')).eql({ ok: false, baseUrl: 'http://localhost:11434' });
  });

  it('should refuse text that is no address at all', () => {
    should(ollamaAddress('http://')).eql({ ok: false, baseUrl: DEFAULT_OLLAMA_URL });
  });
});

describe('parseOllamaTags', () => {
  it('should list each installed model in the order Ollama gave, with what it said about it', () => {
    // Act
    const models = parseOllamaTags(TAGS);

    // Assert
    should(models).eql([
      {
        id: 'gpt-oss:20b',
        label: 'gpt-oss:20b',
        sizeBytes: 13_780_173_839,
        parameterSize: '20.9B',
        quantization: 'MXFP4',
        family: 'gptoss',
        modifiedAt: '2025-08-06T17:12:42.123Z',
      },
      { id: 'llama3.2:latest', label: 'llama3.2:latest', sizeBytes: 2_019_393_189 },
    ]);
  });

  it('should drop a name the CLIs could not be handed, a repeat, a half-formed entry and a blank detail', () => {
    // Act
    const models = parseOllamaTags({
      models: [
        { name: 'has space:1' },
        { name: 'a:1', modified_at: 'not a date', details: { family: '  ', parameter_size: '' } },
        { name: 'a:1' },
        { nope: true },
        'text',
      ],
    });

    // Assert
    should(models).eql([{ id: 'a:1', label: 'a:1' }]);
  });

  it('should say nothing when the reply is not Ollama’s', () => {
    should(parseOllamaTags({ models: 'none' })).be.undefined();
    should(parseOllamaTags([])).be.undefined();
    should(parseOllamaTags(null)).be.undefined();
  });

  it('should read an empty shelf as no models', () => {
    should(parseOllamaTags({ models: [] })).eql([]);
  });
});

describe('suggestedOllamaModel', () => {
  it('should suggest the Ollama catalog’s default', () => {
    should(suggestedOllamaModel(builtInModelCatalogs())).equal('gpt-oss:20b');
  });

  it('should fall back to the model Ollama’s Codex guide suggests when the catalog is gone', () => {
    should(suggestedOllamaModel({})).equal('gpt-oss:20b');
    should(pullCommand('llama3.2')).equal('ollama pull llama3.2');
  });
});

describe('describeOllama', () => {
  const describeIt = (outcome: Parameters<typeof describeOllama>[0]['outcome'], address: OllamaAddress = OK) =>
    describeOllama({ address, outcome, suggested: 'gpt-oss:20b', at: AT });

  it('should say how many models are installed, and carry them', () => {
    // Act
    const view = describeIt({ kind: 'completion', payload: TAGS });

    // Assert
    should(view).match({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      state: 'found',
      checkedAt: AT,
      message: 'Ollama has 2 models installed on this machine.',
      pullCommand: 'ollama pull gpt-oss:20b',
    });
    should(view.models.map(model => model.id)).eql(['gpt-oss:20b', 'llama3.2:latest']);
    should(describeIt({ kind: 'completion', payload: { models: [{ name: 'a:1' }] } }).message).equal(
      'Ollama has 1 model installed on this machine.',
    );
  });

  it('should give the exact command when Ollama is running with nothing pulled', () => {
    // Act
    const view = describeIt({ kind: 'completion', payload: { models: [] } });

    // Assert
    should(view.state).equal('none-pulled');
    should(view.models).eql([]);
    should(view.message).equal('Ollama is running, but no model is installed yet. Run: ollama pull gpt-oss:20b');
  });

  it('should say Ollama is not running, and how to start it, when nothing answers', () => {
    for (const outcome of [{ kind: 'unreachable' }, { kind: 'timeout' }] as const) {
      // Act
      const view = describeIt(outcome);

      // Assert
      should(view.state).equal('not-running');
      should(view.message).equal(
        'Ollama is not running at http://127.0.0.1:11434. Start it (open the Ollama app, or run: ollama serve), then check again.',
      );
    }
  });

  it('should say something other than Ollama answered when the reply cannot be read', () => {
    for (const outcome of [
      { kind: 'completion', payload: { hello: 'world' } },
      { kind: 'status', status: 500 },
      { kind: 'unreadable' },
      { kind: 'oversized' },
      { kind: 'refused' },
    ] as const) {
      // Act
      const view = describeIt(outcome);

      // Assert
      should(view.state).equal('unreadable');
      should(view.message).startWith('Something answered at http://127.0.0.1:11434, but not as Ollama does.');
    }
  });

  it('should refuse an address off this machine, and say reading is off when it is', () => {
    // Act
    const refused = describeIt(undefined, { ok: false, baseUrl: 'http://gpu-box.lan:11434' });
    const disabled = describeOllama({ address: OK, outcome: undefined, disabled: true, suggested: 'x:1', at: AT });

    // Assert
    should(refused.state).equal('refused');
    should(refused.baseUrl).equal('http://gpu-box.lan:11434');
    should(disabled.state).equal('disabled');
    should(disabled.pullCommand).equal('ollama pull x:1');
  });
});
