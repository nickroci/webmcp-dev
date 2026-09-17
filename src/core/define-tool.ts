import { z } from 'zod';
import type { ExecutionOptions, PluginTool, ToolDefinition } from './types';
import { ToolError } from '../errors';

export function defineTool<S extends z.ZodType, O extends z.ZodType = z.ZodUnknown>(options: {
  name: string; title?: string; description: string; schema: S;
  output?: O;
  annotations: ToolDefinition['annotations']; buttonLabel?: string; defaults?: Record<string, unknown>;
  execute(input: z.output<S>, options: ExecutionOptions): z.input<O> | Promise<z.input<O>>;
}): PluginTool {
  const { schema, output, execute, ...definition } = options;
  return { ...definition, inputSchema: z.toJSONSchema(schema, { io: 'input', target: 'draft-07' }),
    ...(output ? { outputSchema: z.toJSONSchema(output, { io: 'output', target: 'draft-07' }) } : {}),
    async execute(input, context) {
      context.signal?.throwIfAborted();
      const parsed = await schema.safeParseAsync(input);
      if (!parsed.success) throw new ToolError('INVALID_INPUT', 'Tool arguments are invalid.', parsed.error.issues.map(({ path, message }) => ({ path, message })));
      context.signal?.throwIfAborted();
      const result = await execute(parsed.data, context);
      if (!output) return result;
      const validated = await output.safeParseAsync(result);
      if (!validated.success) throw new ToolError('INVALID_OUTPUT', 'The tool returned a result that does not match its output schema.', validated.error.issues.map(({ path, message }) => ({ path, message })));
      return validated.data;
    },
  };
}
