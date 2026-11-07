import should from 'should';
import type { z } from 'zod';

export interface SchemaCase {
  name: string;
  schema: z.ZodType;
  value: unknown;
}

export const assertRoundTrips = (cases: readonly SchemaCase[]): void => {
  for (const entry of cases) {
    const first = entry.schema.parse(entry.value);
    const second = entry.schema.parse(first);
    should(second).deepEqual(first);
  }
};

export const assertRejects = (cases: readonly SchemaCase[]): void => {
  for (const entry of cases) {
    should(entry.schema.safeParse(entry.value).success).be.false();
  }
};

export const assertCoversEverySchema = (
  module: Readonly<Record<string, unknown>>,
  cases: readonly SchemaCase[],
): void => {
  const covered = new Set(cases.map(entry => entry.schema));
  const missing = Object.entries(module)
    .filter(([name]) => name.endsWith('Schema'))
    .filter(([, schema]) => !covered.has(schema as z.ZodType))
    .map(([name]) => name)
    .sort();
  should(missing).deepEqual([]);
};
