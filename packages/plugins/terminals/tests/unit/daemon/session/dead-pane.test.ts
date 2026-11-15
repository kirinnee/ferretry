import { describe, it } from 'bun:test';
import should from 'should';
import { type DeadPanePorts, deadPaneText } from '../../../../daemon/lib/session/dead-pane.ts';

function ports(overrides: Partial<DeadPanePorts> = {}): DeadPanePorts & { readonly read: string[] } {
  const read: string[] = [];
  return {
    read,
    paneOf: async () => ({ paneId: '%9' }),
    screen: async paneId => {
      read.push(paneId);
      return 'Error: workspace routing discovery failed';
    },
    ...overrides,
  };
}

describe('deadPaneText', () => {
  it('reads the registered pane by its exact id and answers what it showed', async () => {
    const world = ports();
    should(await deadPaneText(world, 'f1')).equal('Error: workspace routing discovery failed');
    should(world.read).deepEqual(['%9']);
  });

  it('answers an empty text, reading nothing, for a ferret with no registered pane', async () => {
    const world = ports({ paneOf: async () => undefined });
    should(await deadPaneText(world, 'f1')).equal('');
    should(world.read).deepEqual([]);
  });

  it('answers an empty text when the screen could not be read or a hold refused it', async () => {
    should(await deadPaneText(ports({ screen: async () => undefined }), 'f1')).equal('');
  });

  it('answers an empty text, never a throw, when the registry or the read fails', async () => {
    const registry = ports({
      paneOf: async () => {
        throw new Error('state unreadable');
      },
    });
    should(await deadPaneText(registry, 'f1')).equal('');
    const screen = ports({
      screen: async () => {
        throw new Error('tmux gone');
      },
    });
    should(await deadPaneText(screen, 'f1')).equal('');
  });
});
