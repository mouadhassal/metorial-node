import type { JsonSchema } from '@metorial/json-schema';

type JsonSchemaRecord = Record<string, any>;

let isRecord = (value: unknown): value is JsonSchemaRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value);

let typesOf = (schema: JsonSchemaRecord): string[] =>
  Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];

let isObjectSchema = (schema: JsonSchemaRecord) =>
  typesOf(schema).includes('object') || isRecord(schema.properties);

let mapSubschemas = (
  schema: JsonSchemaRecord,
  fn: (sub: JsonSchemaRecord) => JsonSchemaRecord
): JsonSchemaRecord => {
  let out: JsonSchemaRecord = { ...schema };
  for (let key of ['properties', 'patternProperties', '$defs', 'definitions']) {
    if (isRecord(out[key])) {
      out[key] = Object.fromEntries(
        Object.entries(out[key]).map(([k, v]) => [k, isRecord(v) ? fn(v) : v])
      );
    }
  }
  for (let key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else']) {
    if (isRecord(out[key])) out[key] = fn(out[key]);
  }
  for (let key of ['items', 'prefixItems', 'anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(out[key]))
      out[key] = out[key].map((v: any) => (isRecord(v) ? fn(v) : v));
  }
  return out;
};

let resolvePointer = (root: JsonSchemaRecord, ref: string): JsonSchemaRecord | undefined => {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let node: any = root;
  for (let part of ref.slice(2).split('/')) {
    let key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isRecord(node) || !(key in node)) return undefined;
    node = node[key];
  }
  return isRecord(node) ? node : undefined;
};

export let acceptsNull = (schema: unknown): boolean => {
  if (!isRecord(schema)) return true;
  let constraints = Object.keys(schema).filter(k => k !== 'description' && k !== 'title');
  if (constraints.length === 0) return true;
  if (typesOf(schema).includes('null') || schema.nullable === true || schema.const === null) {
    return true;
  }
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  return ['anyOf', 'oneOf'].some(k => Array.isArray(schema[k]) && schema[k].some(acceptsNull));
};

/**
 * Removes keywords that only describe the document ($schema, $id). Definitions are kept:
 * `$ref`s point into them, so dropping them leaves the references dangling.
 */
export let stripMetaKeywords = (schema: JsonSchema): JsonSchema => {
  if (!isRecord(schema)) return schema;
  let { $schema, $id, ...rest } = schema;
  return mapSubschemas(rest, s => stripMetaKeywords(s) as JsonSchemaRecord) as JsonSchema;
};

// Keywords strict mode rejects or does not document (OpenAI Structured Outputs, "Supported schemas").
let NOT_STRICT_COMPATIBLE = [
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'dependentRequired',
  'dependentSchemas',
  'oneOf',
  'prefixItems',
  'patternProperties'
];

let makeNullable = (schema: JsonSchemaRecord): JsonSchemaRecord => {
  if (acceptsNull(schema)) return schema;
  if (typeof schema.type === 'string' && !('enum' in schema) && !('const' in schema)) {
    return { ...schema, type: [schema.type, 'null'] };
  }
  let { description, ...rest } = schema;
  return {
    ...(description === undefined ? {} : { description }),
    anyOf: [rest, { type: 'null' }]
  };
};

/**
 * Converts a schema for strict mode: every object closed, every property required, and
 * properties that were optional made nullable so the model can still leave them out.
 *
 * `lossless` is false when strict mode cannot express the schema without changing what the
 * tool accepts (free-form objects, unsupported keywords, untyped values). Those tools should
 * be sent with strict mode off rather than with a schema that means something else.
 */
export let toStrictSchema = (
  schema: JsonSchema
): { schema: JsonSchema; lossless: boolean } => {
  let lossless = true;
  let properties = 0;

  let visit = (node: JsonSchemaRecord, depth: number): JsonSchemaRecord => {
    let { format, ...result } = node;

    if (NOT_STRICT_COMPATIBLE.some(k => k in result)) lossless = false;
    let composite = ['anyOf', 'oneOf', 'allOf', '$ref', 'enum', 'const'].some(
      k => k in result
    );
    if (!composite && typesOf(result).length === 0) lossless = false;

    if (isObjectSchema(result)) {
      let props: JsonSchemaRecord = isRecord(result.properties) ? result.properties : {};
      let keys = Object.keys(props);
      // Declared properties (even none, as for a tool without arguments) describe a closed shape.
      // Records and catch-alls accept any key, which strict mode cannot express.
      let freeForm =
        result.additionalProperties === true ||
        isRecord(result.additionalProperties) ||
        'propertyNames' in result ||
        (!isRecord(result.properties) && result.additionalProperties !== false);
      if (freeForm) lossless = false;
      if (depth > 10) lossless = false;
      properties += keys.length;

      let required = new Set(Array.isArray(result.required) ? result.required : []);
      result.properties = Object.fromEntries(
        keys.map(k => {
          let converted = isRecord(props[k]) ? visit(props[k], depth + 1) : props[k];
          return [
            k,
            required.has(k) || !isRecord(converted) ? converted : makeNullable(converted)
          ];
        })
      );
      result.required = keys;
      result.additionalProperties = false;
      delete result.propertyNames;
    }

    for (let key of ['items', 'not', 'if', 'then', 'else']) {
      if (isRecord(result[key])) result[key] = visit(result[key], depth);
    }
    for (let key of ['items', 'prefixItems', 'anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(result[key])) {
        result[key] = result[key].map((v: any) => (isRecord(v) ? visit(v, depth) : v));
      }
    }
    for (let key of ['$defs', 'definitions']) {
      if (isRecord(result[key])) {
        result[key] = Object.fromEntries(
          Object.entries(result[key]).map(([k, v]) => [k, isRecord(v) ? visit(v, depth) : v])
        );
      }
    }
    return result;
  };

  if (!isRecord(schema)) return { schema, lossless: false };
  if (!typesOf(schema).includes('object') || 'anyOf' in schema) lossless = false;
  let converted = visit(schema, 1);
  if (properties > 5000) lossless = false;

  return { schema: converted as JsonSchema, lossless };
};

/**
 * Replaces local `$ref`s with the schema they point to, for formats without references
 * (Gemini's OpenAPI subset). A reference met again inside its own expansion is cut to its type.
 */
export let inlineRefs = (schema: JsonSchema): JsonSchema => {
  if (!isRecord(schema)) return schema;
  let root = schema;

  let visit = (node: JsonSchemaRecord, seen: string[]): JsonSchemaRecord => {
    if (typeof node.$ref === 'string') {
      let { $ref, ...rest } = node;
      let target = resolvePointer(root, $ref);
      if (!target || seen.includes($ref)) {
        let cut: JsonSchemaRecord = {};
        if (typeof target?.type === 'string') cut.type = target.type;
        if (typeof target?.description === 'string') cut.description = target.description;
        return { ...cut, ...rest };
      }
      return visit({ ...target, ...rest }, [...seen, $ref]);
    }
    let { $defs, definitions, ...rest } = node;
    return mapSubschemas(rest, s => visit(s, seen));
  };

  return visit(root, []) as JsonSchema;
};

/**
 * Strict mode sends `null` for optional properties the model leaves out. Drop those nulls
 * wherever the tool's own schema does not accept null, so the server sees the property as absent.
 */
export let dropNullsForOptional = (schema: JsonSchema, value: any, root = schema): any => {
  let resolved: unknown =
    isRecord(schema) && typeof schema.$ref === 'string' && isRecord(root)
      ? resolvePointer(root, schema.$ref)
      : schema;
  if (!isRecord(resolved)) return value;
  let node = resolved;

  if (Array.isArray(value) && isRecord(node.items)) {
    return value.map(v => dropNullsForOptional(node.items, v, root));
  }
  if (!isRecord(value) || !isRecord(node.properties)) return value;

  let required = new Set(Array.isArray(node.required) ? node.required : []);
  let out: JsonSchemaRecord = {};
  for (let [key, v] of Object.entries(value)) {
    let prop = node.properties[key];
    let propNode =
      isRecord(prop) && typeof prop.$ref === 'string' && isRecord(root)
        ? resolvePointer(root, prop.$ref)
        : prop;
    if (v === null && !required.has(key) && prop !== undefined && !acceptsNull(propNode)) {
      continue;
    }
    out[key] = prop === undefined ? v : dropNullsForOptional(prop, v, root);
  }
  return out;
};
