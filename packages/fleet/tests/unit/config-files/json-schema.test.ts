import { describe, it } from 'bun:test';
import { CONFIG_SCHEMA_IDS } from '@ferretry/protocol';
import should from 'should';
import { configJsonSchema, configJsonSchemaFiles } from '../../../src/lib/config-files/json-schema.ts';

describe('configJsonSchema', () => {
  it.each([...CONFIG_SCHEMA_IDS])('should be an object schema titled for the %s file', id => {
    // Act
    const actual = configJsonSchema(id);

    // Assert
    should(actual.type).equal('object');
    should(actual.title).equal(`Ferretry ${id} configuration file`);
  });

  it('should list the keys machine.yaml takes, advanced and Ferretry settings included', () => {
    // Act
    const actual = configJsonSchema('machine') as {
      properties: Record<string, { properties?: Record<string, unknown> }>;
    };

    // Assert
    should(Object.keys(actual.properties).toSorted()).deepEqual([
      'advanced',
      'agendaMode',
      'agendaNudge',
      'agentControl',
      'agentPermissions',
      'attentionNudge',
      'autoResume',
      'browserMode',
      'browserPorts',
      'browserProxy',
      'conversations',
      'defaultRuntime',
    ]);
    should(Object.keys(actual.properties.agentControl?.properties ?? {})).containEql('ferretrySettings');
    should(Object.keys(actual.properties.conversations?.properties ?? {})).deepEqual(['listComputer']);
  });

  it('should describe a file as it is WRITTEN: a defaulted key is not required', () => {
    // Act
    const actual = configJsonSchema('profile') as { required?: string[] };

    // Assert
    should(actual.required ?? []).deepEqual([]);
  });

  it('should still render a schema that holds a rule JSON Schema cannot express', () => {
    // Act
    const actual = configJsonSchema('component-modelSets') as { required?: string[] };

    // Assert
    should(actual.required).deepEqual(['models', 'default']);
  });
});

describe('configJsonSchemaFiles', () => {
  it('should hold one entry per schema id, in the id order', () => {
    // Act
    const actual = configJsonSchemaFiles();

    // Assert
    should([...actual.keys()]).deepEqual([...CONFIG_SCHEMA_IDS]);
  });

  it('should write each as pretty JSON ending in one newline, that reads back as the schema', () => {
    // Act
    const actual = configJsonSchemaFiles();

    // Assert
    for (const id of CONFIG_SCHEMA_IDS) {
      const text = actual.get(id) as string;
      should(text.endsWith('}\n')).be.true();
      should(text.includes('\n  "')).be.true();
      should(JSON.parse(text)).deepEqual(JSON.parse(JSON.stringify(configJsonSchema(id))));
    }
  });
});
