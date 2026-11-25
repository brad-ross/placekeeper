import type { App, McpUiSupportedContentBlockModalities } from '@modelcontextprotocol/ext-apps';
import type { OpenAIModelContext, OpenAIModelContextHostState } from '@openai/mcp-extensions/app';

type State = NonNullable<OpenAIModelContextHostState>;
type Block = NonNullable<State['content']>[number];
type Meta = Record<string, unknown> | undefined;

function withoutOpenAIMeta<T extends { _meta?: Meta }>(value: T): T {
    if (!value._meta) return value;
    const { _meta, ...rest } = value;
    const kept = Object.fromEntries(Object.entries(_meta).filter(([key]) => !key.startsWith('openai/')));
    return (Object.keys(kept).length ? { ...rest, _meta: kept } : rest) as T;
}

/** Translates one block to what the host declares; undefined drops it. */
function translate(block: Block, accepts: McpUiSupportedContentBlockModalities): Block | undefined {
    switch (block.type) {
        case 'text': return accepts.text ? withoutOpenAIMeta(block) : undefined;
        case 'image': return accepts.image ? withoutOpenAIMeta(block) : undefined;
        case 'audio': return accepts.audio ? withoutOpenAIMeta(block) : undefined;
        case 'resource_link': return accepts.resourceLink ? withoutOpenAIMeta(block) : undefined;
        case 'resource':
            if (accepts.resource) return { ...withoutOpenAIMeta(block), resource: withoutOpenAIMeta(block.resource) };
            if (accepts.text && 'text' in block.resource && (block.resource.mimeType ?? 'text/plain') === 'text/plain') {
                return { type: 'text', text: block.resource.text };
            }
            return undefined;
        default: return undefined;
    }
}

/**
 * `OpenAIModelContext` over the standard `ui/update-model-context` request, for
 * MCP Apps hosts without OpenAI's model-context extension. The host offers no
 * readback, so `getCurrent()` reports the last state this adapter delivered
 * (undefined before the first delivery), in the coordinator's own block form so
 * an echo matches its receipt. Returns undefined unless the host advertises
 * `updateModelContext` with text or resource support.
 */
export function createStandardModelContext(app: App): OpenAIModelContext | undefined {
    const declared = app.getHostCapabilities?.()?.updateModelContext;
    if (!declared) return undefined;
    // A host that advertises the request without listing modalities is assumed to take plain text.
    const accepts: McpUiSupportedContentBlockModalities = Object.keys(declared).length ? declared : { text: {} };
    if (!accepts.text && !accepts.resource) return undefined;
    let current: State | undefined;
    let sequence = 0;
    return {
        getCurrent: () => current,
        update: async (params, options) => {
            const content = (params.content ?? []).flatMap(block => translate(block as Block, accepts) ?? []);
            const structured = params.structuredContent;
            const sendStructured = accepts.structuredContent !== undefined && structured !== undefined && Object.keys(structured).length > 0;
            await app.updateModelContext({ content, ...(sendStructured ? { structuredContent: structured } : {}) }, options);
            const updateId = `standard-${++sequence}`;
            current = {
                updateId,
                ...(params.content === undefined ? {} : { content: params.content as Block[] }),
                ...(structured === undefined ? {} : { structuredContent: structured }),
            };
            return { updateId };
        },
    };
}
