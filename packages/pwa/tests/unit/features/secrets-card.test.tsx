import { describe, expect, it } from 'bun:test';
import { SECRET_SCHEMA_VERSION, type SecretList } from '@ferretry/protocol';

import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import {
  SECRET_LIMIT,
  SECRET_MASK,
  SECRET_PROMISE,
  listSecrets,
  putSecret,
  removeSecret,
  SECRETS_PATH,
} from '../../../src/features/secrets/secrets-api.ts';
import { SecretsCard, secretDraftProblem } from '../../../src/features/secrets/secrets-card.tsx';
import { SecretsSurface } from '../../../src/features/secrets/secrets-surface.tsx';
import { render, run, runAsync } from '../../support/react.ts';

const AT = '2026-08-05T10:00:00.000Z';
const LATER = '2026-08-06T10:00:00.000Z';

const connection = (id: string) =>
  daemonConnection({ daemonId: id, baseUrl: `https://${id}.example.test`, deviceToken: `token-${id}` });

const list = (overrides: Partial<SecretList> = {}): SecretList => ({
  v: SECRET_SCHEMA_VERSION,
  health: 'ready',
  secrets: [{ name: 'ANTHROPIC_API_KEY', createdAt: AT, updatedAt: AT }],
  references: [],
  ...overrides,
});

function text(node: unknown): string {
  return JSON.stringify(node);
}

describe('SecretsCard', () => {
  it('shows the mask and the two sentences, and never a value', () => {
    // Arrange / Act
    const renderer = render(<SecretsCard list={list()} onPut={() => undefined} onRemove={() => undefined} />);

    // Assert — the mask is the only thing that exists; there is nothing to reveal.
    expect(renderer.root.findByProps({ 'data-secret-mask': '' }).children.join('')).toBe(SECRET_MASK);
    const rendered = text(renderer.toJSON());
    expect(rendered).toContain(SECRET_PROMISE);
    expect(rendered).toContain(SECRET_LIMIT);
    // The claim that would be FALSE.
    expect(rendered).not.toContain('Agents cannot see');
  });

  it('offers no affordance that could reveal a value', () => {
    // Arrange
    const renderer = render(<SecretsCard list={list()} onPut={() => undefined} onRemove={() => undefined} />);

    // Act
    const labels = renderer.root.findAllByType('button').map(button => String(button.props['aria-label'] ?? ''));

    // Assert
    expect(labels.some(label => /show|reveal|copy|view/iu.test(label))).toBe(false);
    expect(labels).toContain('Replace ANTHROPIC_API_KEY');
    expect(labels).toContain('Delete ANTHROPIC_API_KEY');
  });

  it('distinguishes a secret that was set from one that was rotated', () => {
    // Arrange / Act
    const renderer = render(
      <SecretsCard
        list={list({ secrets: [{ name: 'ROTATED', createdAt: AT, updatedAt: LATER }] })}
        onPut={() => undefined}
        onRemove={() => undefined}
      />,
    );

    // Assert
    expect(text(renderer.toJSON())).toContain('changed');
  });

  it('says a store is empty only when it is', () => {
    const renderer = render(
      <SecretsCard list={list({ secrets: [] })} onPut={() => undefined} onRemove={() => undefined} />,
    );
    expect(renderer.root.findByProps({ 'data-testid': 'secrets-empty' }).type).toBe('p');
  });

  it('renders a damaged store as damaged, warning against writing over it', () => {
    // Arrange / Act
    const renderer = render(
      <SecretsCard
        list={list({ health: 'damaged', diagnosis: 'the vault key is gone', secrets: [] })}
        onPut={() => undefined}
        onRemove={() => undefined}
      />,
    );

    // Assert — the failure this project has now shipped three times.
    const damaged = text(renderer.toJSON());
    expect(renderer.root.findByProps({ 'data-testid': 'secrets-damaged' }).type).toBe('div');
    expect(damaged).toContain('the vault key is gone');
    expect(damaged).toContain('It is not empty');
  });

  it('names a configured reference the store cannot resolve', () => {
    // Arrange / Act
    const renderer = render(
      <SecretsCard
        list={list({
          references: [
            { name: 'HELD', origin: 'config/daemon.json → secretEnvironment.A', resolved: true },
            { name: 'ABSENT', origin: 'config/daemon.json → secretEnvironment.B', resolved: false },
          ],
        })}
        onPut={() => undefined}
        onRemove={() => undefined}
      />,
    );

    // Assert — a broken reference is what a person needs BEFORE something fails obscurely; a
    // resolved one is noise.
    const rendered = text(renderer.toJSON());
    expect(renderer.root.findAllByProps({ 'data-testid': 'secrets-unresolved' }).length).toBeGreaterThan(0);
    expect(rendered).toContain('secretEnvironment.B');
    expect(rendered).not.toContain('secretEnvironment.A');
  });

  it('stores a value and clears the form, sending the name and the value once', async () => {
    // Arrange
    const stored: [string, string][] = [];
    const renderer = render(
      <SecretsCard
        list={list({ secrets: [] })}
        onPut={(name, value) => {
          stored.push([name, value]);
        }}
        onRemove={() => undefined}
      />,
    );
    const field = (label: string) =>
      renderer.root.findAllByType('input').find(input => input.props.placeholder?.includes(label));

    // Act
    run(() => field('ANTHROPIC')?.props.onChange({ target: { value: 'new_token' } }));
    run(() => field('paste it here')?.props.onChange({ target: { value: 'sk-live-0123456789' } }));
    await runAsync(async () => {
      renderer.root.findByProps({ 'aria-label': 'Add or replace a secret' }).props.onSubmit({ preventDefault() {} });
    });

    // Assert — the name is upper-cased on the way in, because it becomes an environment variable.
    expect(stored).toEqual([['NEW_TOKEN', 'sk-live-0123456789']]);
  });

  it('removes by name', () => {
    // Arrange
    const removed: string[] = [];
    const renderer = render(
      <SecretsCard
        list={list()}
        onPut={() => undefined}
        onRemove={name => {
          removed.push(name);
        }}
      />,
    );

    // Act
    run(() => renderer.root.findByProps({ 'aria-label': 'Delete ANTHROPIC_API_KEY' }).props.onClick());

    // Assert
    expect(removed).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('prefills the name when replacing, so a rotation is one field', () => {
    // Arrange
    const renderer = render(<SecretsCard list={list()} onPut={() => undefined} onRemove={() => undefined} />);

    // Act
    run(() => renderer.root.findByProps({ 'aria-label': 'Replace ANTHROPIC_API_KEY' }).props.onClick());

    // Assert
    const name = renderer.root.findAllByType('input').find(input => input.props.placeholder?.includes('ANTHROPIC'));
    expect(name?.props.value).toBe('ANTHROPIC_API_KEY');
  });

  it('surfaces a write failure', () => {
    const renderer = render(
      <SecretsCard list={list()} error="the vault is full" onPut={() => undefined} onRemove={() => undefined} />,
    );
    expect(text(renderer.toJSON())).toContain('the vault is full');
  });

  it('shows a save in flight', () => {
    const renderer = render(
      <SecretsCard list={list()} busy="ANTHROPIC_API_KEY" onPut={() => undefined} onRemove={() => undefined} />,
    );
    expect(text(renderer.toJSON())).toContain('Saving…');
  });

  it('does not submit a draft that is not ready', async () => {
    // Arrange
    const stored: string[] = [];
    const renderer = render(
      <SecretsCard
        list={list({ secrets: [] })}
        onPut={name => {
          stored.push(name);
        }}
        onRemove={() => undefined}
      />,
    );

    // Act — an empty form.
    await runAsync(async () => {
      renderer.root.findByProps({ 'aria-label': 'Add or replace a secret' }).props.onSubmit({ preventDefault() {} });
    });

    // Assert
    expect(stored).toEqual([]);
  });
});

describe('the draft problem', () => {
  it('stays quiet until there is something to judge', () => {
    expect(secretDraftProblem('', '', [])).toBeUndefined();
    expect(secretDraftProblem('TOKEN', '', [])).toBeUndefined();
  });

  it('explains a name a shell could not export', () => {
    expect(secretDraftProblem('lower case', 'sk-live-0123456789', [])).toContain('uppercase');
  });

  it('explains a value too short to mask safely', () => {
    expect(secretDraftProblem('TOKEN', 'short', [])).toContain('masked out of output');
  });

  it('warns that saving over an existing name replaces it', () => {
    expect(secretDraftProblem('TOKEN', 'sk-live-0123456789', ['TOKEN'])).toContain('replaces it');
  });

  it('is silent for a clean new draft', () => {
    expect(secretDraftProblem('TOKEN', 'sk-live-0123456789', ['OTHER'])).toBeUndefined();
  });
});

describe('the secrets API', () => {
  it('speaks three routes and no read', async () => {
    // Arrange
    const calls: [string, string][] = [];
    const client = {
      request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: { method?: string }) => {
        calls.push([init?.method ?? 'GET', path]);
        if (path === SECRETS_PATH && init?.method === undefined) return schema.parse(list());
        if (path === SECRETS_PATH) return schema.parse({ name: 'TOKEN', createdAt: AT, updatedAt: AT });
        return schema.parse({ name: 'TOKEN', removed: true });
      },
    } as never;

    // Act
    await listSecrets(client);
    await putSecret(client, 'TOKEN', 'sk-live-0123456789');
    await removeSecret(client, 'TOKEN');

    // Assert
    expect(calls).toEqual([
      ['GET', '/v1/secrets'],
      ['POST', '/v1/secrets'],
      ['DELETE', '/v1/secrets/TOKEN'],
    ]);
  });
});

describe('SecretsSurface', () => {
  it('reads the store for the connection it was given', async () => {
    // Arrange
    const renderer = render(
      <SecretsSurface
        connection={connection('a')}
        createClient={
          (async () => ({
            request: async (_path: string, schema: { parse: (value: unknown) => unknown }) => schema.parse(list()),
          })) as never
        }
      />,
    );
    await runAsync(async () => undefined);

    // Assert
    expect(renderer.root.findByProps({ 'data-testid': 'secrets-card' }).type).toBe('section');
  });

  it('reports a failed read as a refusal, NEVER as an empty store', async () => {
    // Arrange / Act
    const renderer = render(
      <SecretsSurface
        connection={connection('a')}
        createClient={async () => {
          throw new Error('the daemon is unreachable');
        }}
      />,
    );
    await runAsync(async () => undefined);

    // Assert — a person shown "no secrets" here would set every one of them again.
    const rendered = text(renderer.toJSON());
    expect(rendered).toContain('the daemon is unreachable');
    expect(rendered).toContain('not the same as an empty store');
  });

  it('writes and then re-reads, so the screen is what the daemon holds', async () => {
    // Arrange
    const calls: string[] = [];
    const renderer = render(
      <SecretsSurface
        connection={connection('a')}
        createClient={async () =>
          ({
            request: async (
              path: string,
              schema: { parse: (value: unknown) => unknown },
              init?: { method?: string },
            ) => {
              calls.push(`${init?.method ?? 'GET'} ${path}`);
              if (init?.method === undefined) return schema.parse(list());
              return schema.parse({ name: 'TOKEN', createdAt: AT, updatedAt: AT });
            },
          }) as never
        }
      />,
    );
    await runAsync(async () => undefined);

    // Act
    await runAsync(async () => {
      renderer.root.findByType(SecretsCard).props.onPut('TOKEN', 'sk-live-0123456789');
    });

    // Assert
    expect(calls).toEqual(['GET /v1/secrets', 'POST /v1/secrets', 'GET /v1/secrets']);
  });

  it('surfaces a write failure without losing the list', async () => {
    // Arrange
    const renderer = render(
      <SecretsSurface
        connection={connection('a')}
        createClient={async () =>
          ({
            request: async (
              _path: string,
              schema: { parse: (value: unknown) => unknown },
              init?: { method?: string },
            ) => {
              if (init?.method === 'DELETE') throw new Error('the vault key is gone');
              return schema.parse(list());
            },
          }) as never
        }
      />,
    );
    await runAsync(async () => undefined);

    // Act
    await runAsync(async () => {
      renderer.root.findByType(SecretsCard).props.onRemove('ANTHROPIC_API_KEY');
    });

    // Assert
    expect(text(renderer.toJSON())).toContain('the vault key is gone');
  });

  it('shows a reading state rather than an empty one before the first answer', () => {
    // Arrange / Act — no `runAsync`, so the load has not settled.
    const renderer = render(
      <SecretsSurface connection={connection('a')} createClient={async () => await new Promise(() => undefined)} />,
    );

    // Assert
    expect(text(renderer.toJSON())).toContain('Reading this daemon');
  });
});

describe('SecretsSurface across daemons', () => {
  it('drops a daemon‘s answer when the reader has already switched away', async () => {
    // Arrange — a secret belongs to a MACHINE, so daemon A's list must never render as daemon B's.
    let releaseA: ((value: SecretList) => void) | undefined;
    const lateA = new Promise<SecretList>(resolve => {
      releaseA = resolve;
    });
    const createClient = async (active: ReturnType<typeof connection>) =>
      ({
        request: async (_path: string, schema: { parse: (value: unknown) => unknown }) =>
          active.daemonId === 'a'
            ? schema.parse(await lateA)
            : schema.parse(list({ secrets: [{ name: 'ONLY_ON_B', createdAt: AT, updatedAt: AT }] })),
      }) as never;

    // Act
    const renderer = render(<SecretsSurface connection={connection('a')} createClient={createClient} />);
    run(() => renderer.update(<SecretsSurface connection={connection('b')} createClient={createClient} />));
    await runAsync(async () => {
      if (!releaseA) throw new Error('daemon A never began its read');
      releaseA(list({ secrets: [{ name: 'ONLY_ON_A', createdAt: AT, updatedAt: AT }] }));
    });

    // Assert
    const rendered = text(renderer.toJSON());
    expect(rendered).toContain('ONLY_ON_B');
    expect(rendered).not.toContain('ONLY_ON_A');
  });

  it('surfaces a failed write without losing the list', async () => {
    // Arrange
    const renderer = render(
      <SecretsSurface
        connection={connection('a')}
        createClient={
          (async () => ({
            request: async (
              _path: string,
              schema: { parse: (value: unknown) => unknown },
              init?: { method?: string },
            ) => {
              if (init?.method === 'POST') throw new Error('the vault is full');
              return schema.parse(list());
            },
          })) as never
        }
      />,
    );
    await runAsync(async () => undefined);

    // Act
    await runAsync(async () => {
      renderer.root.findByType(SecretsCard).props.onPut('TOKEN', 'sk-live-0123456789');
    });

    // Assert — the list is still there; only the write failed.
    const rendered = text(renderer.toJSON());
    expect(rendered).toContain('the vault is full');
    expect(rendered).toContain('ANTHROPIC_API_KEY');
  });
});
