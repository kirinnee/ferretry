/**
 * Settings › Board: what the board watches. The GitHub watch is `github.watch` in `config/board.yaml`, and it is a
 * switch here: the page reads the file through the kernel's configuration-file routes, and a change edits only that
 * key (the owner's comments and key order stay), against the digest it read. Turning the watch on or off loosens
 * nothing (no authority, no spend), so it applies at once; a daemon that refuses says so in its own words.
 */
import { SettingGroup, SettingRow, SettingSwitch } from '@ferretry/app';
import { useBackgroundLoad } from '@ferretry/app/ui';
import type { AppComponent, PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { editConfigText, readConfigText } from '@ferretry/std/yaml';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { type BoardConfig, BoardConfigSchema } from '../../contract/index.ts';

const FILE = 'board.yaml';

interface Held {
  readonly text: string;
  readonly etag: string;
  readonly config: BoardConfig;
}

/** What a file's text means as a board config: defaults filled, or the defaults when it is empty or does not parse. */
const configOf = (text: string): BoardConfig => {
  const read = readConfigText(text);
  const parsed = BoardConfigSchema.safeParse(read.ok ? (read.read.value ?? {}) : {});
  return parsed.success ? parsed.data : BoardConfigSchema.parse({});
};

const HELD_CHANGE_SENTENCE = 'Saved, but not in effect until you confirm it.';

const said = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.trim() !== '' ? cause.message : fallback;

export const createBoardSettings = (client: PluginClient): AppComponent<SettingsProps> =>
  function BoardSettings(): ReactNode {
    const [held, setHeld] = useState<Held | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    useBackgroundLoad(held === null && note === null);

    const read = useCallback(async () => {
      try {
        const file = (await client.call('GET /v1/config/file', { query: { path: FILE } })) as {
          readonly text?: string;
          readonly etag?: string;
        };
        const text = file.text ?? '';
        setHeld({ text, etag: file.etag ?? '', config: configOf(text) });
        setNote(null);
      } catch (cause) {
        setNote(said(cause, 'The Board settings could not be read.'));
      }
    }, []);
    useEffect(() => {
      void read();
    }, [read]);

    const setWatch = async (watch: boolean): Promise<void> => {
      if (held === null) return;
      setBusy(true);
      setNote(null);
      try {
        const target = { ...held.config, github: { ...held.config.github, watch } };
        const text = editConfigText(held.text === '' ? undefined : held.text, target, held.config, undefined);
        const written = (await client.call('PUT /v1/config/file', {
          body: { path: FILE, text, etag: held.etag },
        })) as { readonly outcome?: string };
        await read();
        // A change that would loosen something is held until the owner confirms it: say so, never show it as saved.
        if (written.outcome === 'pending') setNote(HELD_CHANGE_SENTENCE);
      } catch (cause) {
        setNote(said(cause, 'The change could not be saved.'));
        await read();
      } finally {
        setBusy(false);
      }
    };

    return (
      <section aria-label="Board" className="min-w-0" data-settings="board">
        <SettingGroup label="About the board">
          <li className="py-3 pl-panel pr-1">
            <p className="m-0 text-ui text-muted">
              The board shows the work you asked for as tasks in lanes. Ferretry watches the pull requests a task links
              through GitHub and moves the task when one is opened, passes, merges or ships.
            </p>
          </li>
        </SettingGroup>
        <SettingGroup label="GitHub">
          <SettingRow
            settingId="board-github-watch"
            name="Watch pull requests"
            hint={held === null ? undefined : 'Polls about once a minute'}
            explanation={
              <>
                Saved as <code>github.watch</code> in <code>config/board.yaml</code>, so editing the file by hand works
                too. Off: tasks no longer move by themselves when a pull request changes.
              </>
            }
            control={labelId =>
              held === null ? null : (
                <SettingSwitch
                  checked={held.config.github.watch}
                  labelledBy={labelId}
                  disabled={busy}
                  onChange={next => void setWatch(next)}
                />
              )
            }
          />
        </SettingGroup>
        {note === null ? null : (
          <p
            className={note === HELD_CHANGE_SENTENCE ? 'm-0 px-1 text-ui text-warn' : 'm-0 px-1 text-ui text-err'}
            role="alert"
          >
            {note}
          </p>
        )}
      </section>
    );
  };
