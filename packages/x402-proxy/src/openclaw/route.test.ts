import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createSseTracker, shouldAppendInferenceHistory, writeErrorResponse } from "./route.js";

// ── createSseTracker ────────────────────────────────────────────────

describe("createSseTracker", () => {
  // ── OpenAI format ─────────────────────────────────────────────────

  describe("OpenAI format via pushJson (MPP path)", () => {
    it("extracts usage from final chunk with usage field", () => {
      const tracker = createSseTracker();
      tracker.pushJson('{"choices":[{"delta":{"content":"Hi"}}],"model":"gpt-4"}');
      tracker.pushJson(
        '{"choices":[],"model":"gpt-4","usage":{"prompt_tokens":10,"completion_tokens":5}}',
      );
      expect(tracker.result).toEqual({
        model: "gpt-4",
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      });
    });

    it("extracts reasoning tokens and cache details", () => {
      const tracker = createSseTracker();
      tracker.pushJson(
        JSON.stringify({
          model: "o1",
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            prompt_tokens_details: { cached_tokens: 80, cache_creation_input_tokens: 20 },
            completion_tokens_details: { reasoning_tokens: 30 },
          },
        }),
      );
      expect(tracker.result).toEqual({
        model: "o1",
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 30,
        cacheRead: 80,
        cacheWrite: 20,
      });
    });
  });

  describe("OpenAI format via push (x402 raw SSE path)", () => {
    it("extracts usage from SSE-framed data lines", () => {
      const tracker = createSseTracker();
      tracker.push('data: {"choices":[{"delta":{"content":"Hi"}}],"model":"gpt-4"}\n\n');
      tracker.push(
        'data: {"choices":[],"model":"gpt-4","usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n',
      );
      expect(tracker.result).toEqual({
        model: "gpt-4",
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      });
    });

    it("handles chunks split across push calls", () => {
      const tracker = createSseTracker();
      // Split in the middle of a data line
      tracker.push('data: {"model":"gpt-4","usa');
      tracker.push('ge":{"prompt_tokens":7,"completion_tokens":3}}\n\ndata: [DONE]\n\n');
      expect(tracker.result).toEqual({
        model: "gpt-4",
        inputTokens: 7,
        outputTokens: 3,
        reasoningTokens: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      });
    });
  });

  // ── Anthropic format ──────────────────────────────────────────────

  describe("Anthropic streaming via pushJson (MPP path)", () => {
    it("accumulates usage from message_start and message_delta", () => {
      const tracker = createSseTracker();
      tracker.pushJson(
        JSON.stringify({
          type: "message_start",
          message: {
            model: "claude-opus-4-6",
            usage: { input_tokens: 100, output_tokens: 0 },
          },
        }),
      );
      tracker.pushJson(
        JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      );
      tracker.pushJson(
        JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        }),
      );
      tracker.pushJson(
        JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 15 },
        }),
      );
      tracker.pushJson(JSON.stringify({ type: "message_stop" }));

      expect(tracker.result).toEqual({
        model: "claude-opus-4-6",
        inputTokens: 100,
        outputTokens: 15,
        cacheRead: undefined,
        cacheWrite: undefined,
      });
      expect(tracker.sawAnthropicMessageStop).toBe(true);
    });

    it("extracts cache fields from message_start", () => {
      const tracker = createSseTracker();
      tracker.pushJson(
        JSON.stringify({
          type: "message_start",
          message: {
            model: "claude-sonnet-4-6",
            usage: {
              input_tokens: 200,
              output_tokens: 0,
              cache_creation_input_tokens: 50,
              cache_read_input_tokens: 150,
            },
          },
        }),
      );
      tracker.pushJson(
        JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 20 },
        }),
      );

      expect(tracker.result).toEqual({
        model: "claude-sonnet-4-6",
        inputTokens: 200,
        outputTokens: 20,
        cacheRead: 150,
        cacheWrite: 50,
      });
    });
  });

  describe("Anthropic streaming via push (x402 raw SSE path)", () => {
    it("parses event-framed Anthropic SSE", () => {
      const tracker = createSseTracker();
      tracker.push(
        [
          "event: message_start",
          'data: {"type":"message_start","message":{"model":"claude-opus-4-6","usage":{"input_tokens":50}}}',
          "",
          "event: content_block_delta",
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
          "",
          "event: message_delta",
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":8}}',
          "",
          "event: message_stop",
          'data: {"type":"message_stop"}',
          "",
          "",
        ].join("\n"),
      );

      expect(tracker.result).toEqual({
        model: "claude-opus-4-6",
        inputTokens: 50,
        outputTokens: 8,
        cacheRead: undefined,
        cacheWrite: undefined,
      });
      expect(tracker.sawAnthropicMessageStop).toBe(true);
    });
  });

  describe("Anthropic non-streaming via pushJson", () => {
    it("extracts usage from complete message response", () => {
      const tracker = createSseTracker();
      tracker.pushJson(
        JSON.stringify({
          type: "message",
          id: "msg_123",
          role: "assistant",
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "Hello" }],
          usage: { input_tokens: 42, output_tokens: 7 },
        }),
      );

      expect(tracker.result).toEqual({
        model: "claude-opus-4-6",
        inputTokens: 42,
        outputTokens: 7,
        cacheRead: undefined,
        cacheWrite: undefined,
      });
    });

    it("extracts cache fields from non-streaming response", () => {
      const tracker = createSseTracker();
      tracker.pushJson(
        JSON.stringify({
          type: "message",
          model: "claude-sonnet-4-6",
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 70,
          },
        }),
      );

      expect(tracker.result).toEqual({
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        outputTokens: 10,
        cacheRead: 70,
        cacheWrite: 30,
      });
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("returns undefined for empty tracker", () => {
      const tracker = createSseTracker();
      expect(tracker.result).toBeUndefined();
    });

    it("returns undefined for malformed JSON", () => {
      const tracker = createSseTracker();
      tracker.pushJson("not json at all");
      expect(tracker.result).toBeUndefined();
    });

    it("returns undefined for JSON without usage or type fields", () => {
      const tracker = createSseTracker();
      tracker.pushJson('{"foo":"bar"}');
      expect(tracker.result).toBeUndefined();
    });

    it("does not misdetect OpenAI chunks as Anthropic", () => {
      const tracker = createSseTracker();
      // Full realistic OpenAI streaming sequence
      tracker.pushJson(
        '{"id":"chatcmpl-abc","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      );
      tracker.pushJson(
        '{"id":"chatcmpl-abc","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
      );
      tracker.pushJson(
        '{"id":"chatcmpl-abc","object":"chat.completion.chunk","model":"gpt-4","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}',
      );
      // Should use OpenAI path (has reasoningTokens field), not Anthropic
      expect(tracker.result).toEqual({
        model: "gpt-4",
        inputTokens: 12,
        outputTokens: 3,
        reasoningTokens: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      });
    });

    it("ignores [DONE] sentinel in SSE stream", () => {
      const tracker = createSseTracker();
      tracker.push(
        'data: {"model":"gpt-4","usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
      );
      expect(tracker.result?.inputTokens).toBe(5);
    });
  });
});

describe("shouldAppendInferenceHistory", () => {
  it("skips non-LLM traffic and empty successful placeholders", () => {
    expect(shouldAppendInferenceHistory({ isLlmEndpoint: false })).toBe(false);
    expect(shouldAppendInferenceHistory({ isLlmEndpoint: true })).toBe(false);
  });

  it("keeps usage-bearing and priced LLM requests", () => {
    expect(shouldAppendInferenceHistory({ isLlmEndpoint: true, amount: 0.0133 })).toBe(true);
    expect(
      shouldAppendInferenceHistory({
        isLlmEndpoint: true,
        usage: { model: "stepfun/step-3.5-flash", inputTokens: 10, outputTokens: 2 },
      }),
    ).toBe(true);
  });
});

// ── writeErrorResponse ──────────────────────────────────────────────

describe("writeErrorResponse", () => {
  function mockRes() {
    let body = "";
    let headStatus = 0;
    let headHeaders: Record<string, string> = {};
    return {
      writeHead(status: number, headers: Record<string, string>) {
        headStatus = status;
        headHeaders = headers;
      },
      end(data: string) {
        body = data;
      },
      get _status() {
        return headStatus;
      },
      get _headers() {
        return headHeaders;
      },
      get _body() {
        return body;
      },
    } as unknown as ServerResponse & {
      _status: number;
      _headers: Record<string, string>;
      _body: string;
    };
  }

  it("writes OpenAI error format when isAnthropicFormat is false", () => {
    const res = mockRes();
    writeErrorResponse(res, 402, "Payment failed", "payment_error", "payment_failed", false);
    expect(res._status).toBe(402);
    expect(JSON.parse(res._body)).toEqual({
      error: { message: "Payment failed", type: "payment_error", code: "payment_failed" },
    });
  });

  it("writes Anthropic error format when isAnthropicFormat is true", () => {
    const res = mockRes();
    writeErrorResponse(res, 402, "Payment failed", "payment_error", "payment_failed", true);
    expect(res._status).toBe(402);
    expect(JSON.parse(res._body)).toEqual({
      type: "error",
      error: { type: "payment_error", message: "Payment failed" },
    });
  });

  it("sets Content-Type to application/json", () => {
    const res = mockRes();
    writeErrorResponse(res, 500, "err", "t", "c", false);
    expect(res._headers["Content-Type"]).toBe("application/json");
  });
});
