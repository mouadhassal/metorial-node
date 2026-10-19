import { describe, expect, it } from 'vitest';
import { MetorialMcpTool } from '../mcpTool';
import { dropNullsForOptional, inlineRefs, stripMetaKeywords, toStrictSchema } from './schema';

// Shapes taken from tools in the metorial/metorial catalog, as served by toJsonSchema().
let listItems: any = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    vaultId: { type: 'string', description: 'ID of the vault' },
    filter: { type: 'string', description: 'Optional filter' },
    sort: { type: 'string', enum: ['asc', 'desc'] }
  },
  required: ['vaultId'],
  additionalProperties: false
};

let attributeValue: any = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    tableName: { type: 'string' },
    key: {
      type: 'object',
      propertyNames: { type: 'string' },
      additionalProperties: { $ref: '#/$defs/__schema0' }
    }
  },
  required: ['tableName', 'key'],
  additionalProperties: false,
  $defs: {
    __schema0: {
      type: 'object',
      properties: {
        S: { type: 'string' },
        L: { type: 'array', items: { $ref: '#/$defs/__schema0' } }
      },
      additionalProperties: false
    }
  }
};

describe('stripMetaKeywords', () => {
  it('keeps $defs so $refs still resolve', () => {
    let out = stripMetaKeywords(attributeValue) as any;
    expect(out.$schema).toBeUndefined();
    expect(out.$defs.__schema0.properties.S).toEqual({ type: 'string' });
  });
});

describe('toStrictSchema', () => {
  it('makes optional properties nullable instead of mandatory', () => {
    let { schema, lossless } = toStrictSchema(stripMetaKeywords(listItems)) as any;
    expect(lossless).toBe(true);
    expect(schema.required).toEqual(['vaultId', 'filter', 'sort']);
    expect(schema.properties.vaultId.type).toBe('string');
    expect(schema.properties.filter.type).toEqual(['string', 'null']);
    expect(schema.properties.sort).toEqual({
      anyOf: [{ type: 'string', enum: ['asc', 'desc'] }, { type: 'null' }]
    });
  });

  it('closes objects inside $defs too', () => {
    let { schema } = toStrictSchema({
      type: 'object',
      properties: { node: { $ref: '#/$defs/n' } },
      required: ['node'],
      $defs: { n: { type: 'object', properties: { v: { type: 'number' } } } }
    }) as any;
    expect(schema.$defs.n.additionalProperties).toBe(false);
    expect(schema.$defs.n.required).toEqual(['v']);
    expect(schema.$defs.n.properties.v.type).toEqual(['number', 'null']);
  });

  it('reports free-form objects as not expressible in strict mode', () => {
    expect(toStrictSchema(stripMetaKeywords(attributeValue)).lossless).toBe(false);
    expect(
      toStrictSchema({ type: 'object', properties: { extras: { type: 'object' } } }).lossless
    ).toBe(false);
  });

  it('keeps tools without arguments strict', () => {
    expect(toStrictSchema({ type: 'object', properties: {} })).toEqual({
      schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      lossless: true
    });
  });

  it('reports catch-all objects as not expressible in strict mode', () => {
    expect(
      toStrictSchema({
        type: 'object',
        properties: { id: { type: 'string' } },
        additionalProperties: { type: 'string' }
      }).lossless
    ).toBe(false);
  });

  it('reports untyped values as not expressible in strict mode', () => {
    expect(
      toStrictSchema({ type: 'object', properties: { data: { description: 'anything' } } })
        .lossless
    ).toBe(false);
  });

  it('leaves nullable optional properties alone', () => {
    let { schema } = toStrictSchema({
      type: 'object',
      properties: { cursor: { anyOf: [{ type: 'string' }, { type: 'null' }] } }
    }) as any;
    expect(schema.properties.cursor).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }]
    });
  });
});

describe('inlineRefs', () => {
  it('replaces refs with their definitions and cuts recursion', () => {
    let out = inlineRefs(attributeValue) as any;
    expect(out.$defs).toBeUndefined();
    let value = out.properties.key.additionalProperties;
    expect(value.properties.S).toEqual({ type: 'string' });
    expect(value.properties.L.items).toEqual({ type: 'object' });
    expect(JSON.stringify(out)).not.toContain('$ref');
  });
});

describe('dropNullsForOptional', () => {
  let schema: any = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      note: { type: 'string' },
      cursor: { type: ['string', 'null'] },
      rows: {
        type: 'array',
        items: { type: 'object', properties: { label: { type: 'string' } } }
      }
    },
    required: ['id']
  };

  it('drops nulls the tool would reject and keeps the rest', () => {
    expect(
      dropNullsForOptional(schema, {
        id: 'a',
        note: null,
        cursor: null,
        rows: [{ label: null }, { label: 'x' }]
      })
    ).toEqual({ id: 'a', cursor: null, rows: [{}, { label: 'x' }] });
  });

  it('keeps nulls on required properties', () => {
    expect(dropNullsForOptional(schema, { id: null })).toEqual({ id: null });
  });
});

describe('MetorialMcpTool', () => {
  let session = (calls: any[]) =>
    ({
      getClient: async () => ({
        callTool: async (req: any) => {
          calls.push(req.arguments);
          return { content: [] };
        }
      })
    }) as any;

  it('sends strict schemas only when they are lossless', () => {
    let simple = MetorialMcpTool.fromTool(session([]), {
      type: 'tool',
      tool: { name: 'list_items', inputSchema: listItems }
    });
    let record = MetorialMcpTool.fromTool(session([]), {
      type: 'tool',
      tool: { name: 'get_item', inputSchema: attributeValue }
    });
    expect(simple.getStrictParameters().strict).toBe(true);
    expect(record.getStrictParameters()).toEqual({
      parameters: stripMetaKeywords(attributeValue),
      strict: false
    });
  });

  it('does not forward the nulls strict mode adds for skipped optional properties', async () => {
    let calls: any[] = [];
    let tool = MetorialMcpTool.fromTool(session(calls), {
      type: 'tool',
      tool: { name: 'list_items', inputSchema: listItems }
    });
    await tool.call({ vaultId: 'v1', filter: null, sort: null });
    expect(calls).toEqual([{ vaultId: 'v1' }]);
  });
});
