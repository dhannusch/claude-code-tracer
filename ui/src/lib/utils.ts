import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Type guard to check if value is a record object
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// SSE event record type
export type SSEEventRecord = {
  event: string;
  data: unknown;
  raw: string;
};

// SSE summary type
export type SSESummary = {
  text: string;
  stopReason: string | null;
  usage: unknown | null;
};

/**
 * Parse Server-Sent Events format into structured event records
 */
export function parseSSEToEvents(sse: string): SSEEventRecord[] {
  const records = sse.split("\n\n");
  const events: SSEEventRecord[] = [];
  for (const rec of records) {
    if (!rec) continue;
    const lines = rec.split("\n");
    let evt: string | null = null;
    const dataLines: string[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith("event:")) evt = t.slice(6).trim();
      else if (t.startsWith("data:")) dataLines.push(t.slice(5).trim());
    }
    if (evt == null && dataLines.length === 0) continue;
    const rawData = dataLines.join("\n");
    let parsed: unknown = rawData;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      // keep as string
    }
    events.push({ event: evt ?? "message", data: parsed, raw: rawData });
  }
  return events;
}

/**
 * Summarize Anthropic SSE stream into text, stop reason, and usage
 */
export function summarizeAnthropicSSE(sse: string): SSESummary {
  const records = parseSSEToEvents(sse);
  let text = "";
  let stopReason: string | null = null;
  let usage: unknown | null = null;
  for (const r of records) {
    if (
      r.event === "content_block_delta" &&
      isRecord(r.data)
    ) {
      const delta = r.data.delta;
      if (isRecord(delta) && delta.type === "text_delta" && typeof delta.text === "string") {
        text += delta.text;
      }
    } else if (
      r.event === "message_delta" &&
      isRecord(r.data)
    ) {
      const delta = r.data.delta;
      if (isRecord(delta) && typeof delta.stop_reason === "string") {
        stopReason = delta.stop_reason;
      }
      if (r.data.usage !== undefined) {
        usage = r.data.usage;
      }
    }
  }
  return { text, stopReason, usage };
}

/**
 * Extract text from the first message in a messages array
 */
export function getMessageText(messages: unknown[] | undefined): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const first = messages[0] as Record<string, unknown>;
  const content = first?.content as unknown;
  const text = extractTextFromContent(content);
  if (typeof text === "string" && text.trim().length > 0) return text;
  if (typeof content === "string") return content;
  return typeof content === "undefined" ? "" : JSON.stringify(content, null, 2);
}

/**
 * Calculate total tokens from a usage object
 */
export function calculateTokens(usage: unknown): number {
  if (!isRecord(usage)) return 0;
  const total = usage["total_tokens"];
  if (typeof total === "number" && isFinite(total)) return total;

  const input = usage["input_tokens"];
  const output = usage["output_tokens"];
  const inputNum = typeof input === "number" && isFinite(input) ? input : 0;
  const outputNum = typeof output === "number" && isFinite(output) ? output : 0;
  return inputNum + outputNum;
}

/**
 * Extract response body from trace response object, handling wrapped or direct responses
 */
export function getResponseBody<T = unknown>(trace: { response?: unknown }): T | undefined {
  if (!trace.response) return undefined;
  if (isRecord(trace.response) && 'body' in trace.response) {
    return trace.response.body as T;
  }
  return trace.response as T;
}

/**
 * Extract human-readable text from Anthropic-style message content
 * Handles string, array of content blocks, or object formats
 */
export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (!isRecord(c)) continue;
      const typeVal = (c as Record<string, unknown>)["type"];
      if (typeVal === "text") {
        const textVal = (c as Record<string, unknown>)["text"];
        if (typeof textVal === "string") parts.push(textVal);
      } else if (typeVal === "tool_use") {
        const nameRaw = (c as Record<string, unknown>)["name"];
        const nameVal =
          typeof nameRaw === "string" ? (nameRaw as string) : undefined;
        const inputVal = (c as Record<string, unknown>)["input"] as unknown;
        const label = nameVal ? `Tool call: ${nameVal}` : "Tool call";
        const inputStr =
          typeof inputVal === "string"
            ? inputVal
            : JSON.stringify(inputVal, null, 2);
        parts.push(inputStr ? `${label}\n${inputStr}` : label);
      } else if (typeVal === "tool_result") {
        const toolContent = (c as Record<string, unknown>)[
          "content"
        ] as unknown;
        if (typeof toolContent === "string") {
          parts.push(toolContent);
        } else if (Array.isArray(toolContent)) {
          const inner = toolContent
            .map((tc: unknown) => {
              if (isRecord(tc)) {
                const t = (tc as Record<string, unknown>)["text"];
                if (typeof t === "string") return t as string;
              }
              return JSON.stringify(tc, null, 2);
            })
            .join("\n\n");
          if (inner) parts.push(inner);
        } else if (isRecord(toolContent)) {
          const txt = (toolContent as Record<string, unknown>)["text"];
          if (typeof txt === "string") parts.push(txt as string);
        } else {
          // Fallback to showing the whole tool_result block
          parts.push(JSON.stringify(c, null, 2));
        }
      }
    }
    if (parts.length > 0) return parts.join("\n\n");
    return JSON.stringify(content, null, 2);
  }
  if (isRecord(content)) {
    const textVal = content["text"];
    if (typeof textVal === "string") return textVal;
    const contentVal = content["content"];
    if (typeof contentVal === "string") return contentVal;
  }
  return typeof content === "undefined" ? "" : JSON.stringify(content, null, 2);
}

/**
 * Prettify text by unescaping common double-escaped sequences and tidying whitespace
 */
export function prettifyText(raw: string): string {
  if (!raw) return "";
  let s = String(raw);
  // Normalize newlines
  s = s.replace(/\r\n?/g, "\n");
  // Unescape common double-escaped sequences that show up when JSON is rendered as JSON again
  s = s.replace(/\\n/g, "\n");
  s = s.replace(/\\t/g, "  ");
  s = s.replace(/\\r/g, "");
  s = s.replace(/\\\[/g, "[");
  s = s.replace(/\\\]/g, "]");
  s = s.replace(/\\"/g, '"');
  // Collapse excessive blank lines
  s = s.replace(/\n{3,}/g, "\n\n");
  // Replace non-breaking spaces with regular spaces
  s = s.replace(/\u00a0/g, " ");
  return s.trim();
}
