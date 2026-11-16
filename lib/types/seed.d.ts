/**
 * Seed-message construction for custom-first-control-prompt: the request-path
 * alternating user/assistant sequence built once per plugin activation and
 * shared by every intercepted request.
 */
import { type Message } from '@deepseek-ai/dsh-llm';
/** Plugin attribution carried by the injected assistant messages' `source`. */
export declare const SEED_SOURCE = "custom-first-control-prompt";
/**
 * Exchange tags the injected texts may not contain case-insensitively. The
 * reference exchanges travel as plain message texts; embedding the tag
 * grammar would invite the model to re-parse (or forge) exchange markup that
 * no longer exists, so plugin load skips such texts with a warning instead.
 */
export declare const TRANSCRIPT_RESERVED_TAGS: readonly string[];
/** One configured reference exchange between a user and the assistant. */
export interface HistoryPair {
    /**
     * User-side text of the exchange.
     *
     * Optional: leave it out (or empty) to inject only the assistant side —
     * reasoning → text → tool-call — with no user message at all.
     */
    user?: string;
    /** Assistant-side text of the exchange. */
    assistant: string;
    /**
     * Optional assistant-side chain-of-thought text. When present and
     * non-empty, the injected assistant message carries a `reasoning` block
     * ahead of its text block, so a reasoning-capable model sees the reference
     * thinking (providers concatenate `reasoning_content` into context on
     * tool-carrying requests) instead of only the visible answer.
     */
    assistantThinking?: string;
    /**
     * 可选：assistant 正文之后追加的伪造工具调用。
     * 每条生成一个原生 `tool-call` 内容块 —— provider 报文里会变成真的
     * `tool_calls` 字段，模型看到的是"我自己发起过这次调用"。
     *
     * `id` 必须是常量字符串（建议 `seed-call-<条目号>-<调用号>`）：一旦每次
     * 请求都不同，前缀缓存从第一个变化的 token 起全部失效。
     * `arguments` 必须是合法 JSON 的**字符串**。
     */
    toolCalls?: {
        id: string;
        name: string;
        /** 原始 JSON 字符串，与模型真实产出的一致。 */
        arguments: string;
    }[];
    /**
     * 与 `toolCalls` 按索引一一配对的结果。
     * 每条生成一条独立的 `role:'user'` 消息（`source.kind='tool'`，带配对 callId）。
     *
     * **必须与 toolCalls 等长**：只造调用不造结果，OpenAI 兼容 provider 直接 400。
     * 数量多于 toolCalls 的项会被忽略。
     */
    toolResults?: {
        content: string;
        isError?: boolean;
    }[];
}
/**
 * Build the request-level seed messages: one real alternating user/assistant
 * exchange per configured pair, as plain `Message` objects for
 * `GenerateOptions.messages`. Built once per plugin activation and shared by
 * every intercepted request, keeping the injected prefix byte-identical for
 * prefix-cache reuse. These messages never enter the session log — they exist
 * only on the request path, so there is no turn structure to conflict with
 * the loop's turn numbering and nothing for compaction to shadow. The user
 * side carries `kind:'user'` and the assistant side plugin attribution.
 * @param pairs - ordered reference exchanges.
 * @returns the frozen alternating user/assistant message sequence.
 */
export declare function buildSeedMessages(pairs: readonly HistoryPair[]): readonly Message[];
//# sourceMappingURL=seed.d.ts.map