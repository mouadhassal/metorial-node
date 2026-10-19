import { JsonSchema, jsonSchemaToOpenApi } from '@metorial/json-schema';
import { McpUriTemplate } from './lib/mcpUri';
import { dropNullsForOptional, inlineRefs, stripMetaKeywords, toStrictSchema } from './lib/schema';
import { slugify } from './lib/slugify';
import { MetorialMcpSession } from './mcpSession';

export type Capability =
  | {
      type: 'tool';
      tool: {
        name: string;
        description?: string | null;
        inputSchema: any;
      };
    }
  | {
      type: 'resource-template';
      resourceTemplate: {
        name: string;
        description?: string | null;
        uriTemplate: string;
      };
    };

const MAX_RETRIES = 10;

let runWithRetries = async <T>(
  action: () => Promise<T>,
  retries: number = MAX_RETRIES
): Promise<T> => {
  let err: Error | undefined;

  for (let i = 0; i < retries; i++) {
    try {
      return await action();
    } catch (error) {
      err = error as Error;
    }
  }

  throw err!;
};

export class MetorialMcpTool {
  #id: string;
  #name: string;
  #description: string | null;
  #parameters: JsonSchema;

  private constructor(
    private readonly session: MetorialMcpSession,
    opts: {
      id: string;
      name: string;
      description: string | null;
      parameters: JsonSchema;
    },
    private readonly action: (args: any) => Promise<any>
  ) {
    this.#id = opts.id;
    this.#name = opts.name;
    this.#description = opts.description;
    this.#parameters = opts.parameters;
  }

  get name() {
    return this.#name;
  }

  get id() {
    return this.#id;
  }

  get description() {
    return this.#description;
  }

  get parameters() {
    return this.#parameters;
  }

  async call(args: any) {
    return await this.action(dropNullsForOptional(this.#parameters, args));
  }

  /**
   * Parameters for providers with a strict mode. `strict` is false when strict mode cannot
   * express this tool's schema without changing it; send the plain schema without strict then.
   */
  getStrictParameters(): { parameters: JsonSchema; strict: boolean } {
    let plain = stripMetaKeywords(this.#parameters);
    let { schema, lossless } = toStrictSchema(plain);
    return lossless ? { parameters: schema, strict: true } : { parameters: plain, strict: false };
  }

  getParametersAs(
    as:
      | 'json-schema'
      | 'strict-json-schema'
      | 'openapi-3.0.0'
      | 'openapi-3.1.0' = 'json-schema'
  ) {
    if (as == 'json-schema') {
      return stripMetaKeywords(this.#parameters);
    }

    if (as == 'strict-json-schema') {
      return toStrictSchema(stripMetaKeywords(this.#parameters)).schema;
    }

    if (as == 'openapi-3.0.0' || as == 'openapi-3.1.0') {
      return jsonSchemaToOpenApi(inlineRefs(this.#parameters), {
        openApiVersion: as == 'openapi-3.0.0' ? '3.0.0' : '3.1.0',
        preserveJsonSchemaKeywords: false,
        nullHandling: 'nullable'
      });
    }

    throw new Error(`[METORIAL MCP]: Unknown parameters format: ${as}`);
  }

  static fromTool(session: MetorialMcpSession, capability: Capability) {
    if (capability.type !== 'tool') {
      throw new Error(
        `[METORIAL MCP]: Expected capability type to be 'tool', got '${capability.type}'`
      );
    }

    let { tool } = capability;

    return new MetorialMcpTool(
      session,
      {
        id: slugify(tool.name),
        name: tool.name,
        description: tool.description ?? null,
        parameters: tool.inputSchema
      },
      async params =>
        runWithRetries(async () => {
          let client = await session.getClient();

          let result = await client.callTool({
            name: tool.name,
            arguments: params
          });

          return result;
        }, MAX_RETRIES)
    );
  }

  static fromResourceTemplate(session: MetorialMcpSession, capability: Capability) {
    if (capability.type !== 'resource-template') {
      throw new Error(
        `[METORIAL MCP]: Expected capability type to be 'resource-template', got '${capability.type}'`
      );
    }

    let { resourceTemplate } = capability;

    let uri = new McpUriTemplate(resourceTemplate.uriTemplate);

    return new MetorialMcpTool(
      session,
      {
        id: slugify(resourceTemplate.name),
        name: resourceTemplate.name,
        description: resourceTemplate.description ?? null,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            uri.getProperties().map(prop => [prop.key, { type: 'string' }])
          ),
          required: uri
            .getProperties()
            .filter(prop => !prop.optional)
            .map(prop => prop.key),
          additionalProperties: false
        }
      },
      async params =>
        runWithRetries(async () => {
          let client = await session.getClient();

          let finalUri = uri.expand(params);

          let result = await client.readResource({
            uri: finalUri
          });

          return result;
        }, MAX_RETRIES)
    );
  }

  static fromCapability(session: MetorialMcpSession, capability: Capability): MetorialMcpTool {
    if (capability.type === 'tool') {
      return MetorialMcpTool.fromTool(session, capability);
    }

    if (capability.type === 'resource-template') {
      return MetorialMcpTool.fromResourceTemplate(session, capability);
    }

    throw new Error(
      `[METORIAL MCP]: Unknown capability type: ${capability}. Expected 'tool' or 'resource-template'.`
    );
  }
}
