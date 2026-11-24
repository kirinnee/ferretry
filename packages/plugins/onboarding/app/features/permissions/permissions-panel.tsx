/** The `onboarding.step` panel of the "Permissions" page, made for one machine's client (drawn by the setup flow). */
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { HarnessViewSchema } from '../../../contract/index.ts';
import { defaultPick, segmentsOf, type Harness } from '../agents/agents-model.ts';
import { type PermissionsFiles, type ReadFile, PermissionsPage } from './permissions-page.tsx';
import { coveredBy } from './permissions-model.ts';

const READ = 'GET /v1/config/file' as const;
const WRITE = 'PUT /v1/config/file' as const;

/** The daemon shows the comment of a file whose text it withholds; its issue says the same. */
const WITHHELD = /^# ‹hidden›: the text of this file is not shown because/u;

const FileSchema = z.looseObject({
  text: z.string().optional(),
  etag: z.string().optional(),
  absolutePath: z.string().optional(),
  state: z.string().optional(),
});
const WroteSchema = z.looseObject({ outcome: z.enum(['applied', 'pending']) });

const filesOf = (client: PluginClient): PermissionsFiles => ({
  read: async (file): Promise<ReadFile> => {
    const got = FileSchema.parse(await client.call(READ, { quiet: true, query: { path: file } }));
    const text = got.text ?? '';
    return {
      text,
      etag: got.etag ?? '',
      where: got.absolutePath ?? `config/${file}`,
      withheld: WITHHELD.test(text),
      pending: got.state === 'pending',
    };
  },
  write: async (file, text, etag) =>
    WroteSchema.parse(await client.call(WRITE, { body: { path: file, text, etag } })).outcome === 'pending'
      ? 'held'
      : 'applied',
});

/** The harnesses installed on this machine (`GET /v1/onboarding` `harnesses`), read quietly. */
const readInstalled = async (client: PluginClient): Promise<readonly Harness[]> =>
  z
    .object({ harnesses: z.array(HarnessViewSchema).optional() })
    .parse(await client.call('GET /v1/onboarding', { quiet: true })).harnesses ?? [];

export function createPermissionsPanel(client: PluginClient) {
  const files = filesOf(client);
  return function PermissionsPanel({ step }: PanelProps): ReactNode {
    const [installed, setInstalled] = useState<readonly Harness[] | null>(null);
    useEffect(() => {
      let current = true;
      readInstalled(client).then(
        list => current && setInstalled(list),
        () => current && setInstalled([]),
      );
      return () => {
        current = false;
      };
    }, []);
    // The pick of "Which AI" (this run's memory), else the one that page ticks by default.
    const said = step?.segment.agentsOn;
    const harnesses = useMemo(() => {
      if (installed === null) return null;
      const on =
        typeof said === 'string'
          ? said.split(',').filter(id => id !== '')
          : segmentsOf(defaultPick(installed), [], installed).on;
      return coveredBy(on);
    }, [installed, said]);
    if (harnesses === null) return null;
    return <PermissionsPage step={step} harnesses={harnesses} files={files} />;
  };
}
