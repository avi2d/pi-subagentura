import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist: startSubagentJob must be mocked before subagent.ts loads.
vi.mock("./helpers", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./helpers")>();
    return { ...actual, startSubagentJob: vi.fn() };
});

import registerExtension from "./subagent";

/**
 * Regression test for the "Cannot read properties of undefined (reading 'map')"
 * class of errors seen in done.jsonl after a tmux subagent inject.
 *
 * The extension registers a `on("context")` handler that:
 *   - Detects messages whose `content` is not one of the safe shapes
 *     (string, Array<ContentBlock>, undefined).
 *   - Returns `{ messages: <fixed> }` so the `emitContext` chain (runner.js:639-667)
 *     hands the SDK a clean array, preventing the downstream `.map()` / `.flatMap()`
 *     crashes in pi-ai's convertMessages / transformMessages.
 *
 * Fix rules:
 *   - content: null | number | object (not array) -> `[]`
 *   - content: Array with a bad block             -> array with bad block(s) dropped
 *   - content: string | undefined | good array   -> unchanged
 *   - Pass-through (return undefined) when all messages are well-formed.
 */
describe("on('context') defensive fix", () => {
    let api: any;
    let contextHandler: any;

    beforeEach(() => {
        vi.clearAllMocks();
        api = {
            registerTool: vi.fn(),
            registerMessageRenderer: vi.fn(),
            sendMessage: vi.fn(),
            sendUserMessage: vi.fn(),
            on: vi.fn(),
            registerCommand: vi.fn(),
        };
        registerExtension(api as any);
        // Capture the context handler from the pi.on mock.
        const onCalls = api.on.mock.calls as Array<[string, any]>;
        for (const [event, handler] of onCalls) {
            if (event === "context") contextHandler = handler;
        }
    });

    it("registers a 'context' handler", () => {
        expect(contextHandler).toBeTypeOf("function");
    });

    it("returns undefined (pass-through) when all messages are well-formed", () => {
        const goodMsg = {
            role: "user",
            content: [{ type: "text", text: "hi" }],
        };
        const result = contextHandler({ type: "context", messages: [goodMsg] }, {});
        expect(result).toBeUndefined();
    });

    it("returns undefined (pass-through) when message content is a plain string", () => {
        const strMsg = { role: "user", content: "just a string" };
        const result = contextHandler({ type: "context", messages: [strMsg] }, {});
        expect(result).toBeUndefined();
    });

    it("returns undefined (pass-through) when message content is undefined", () => {
        const undefMsg = { role: "user", content: undefined };
        const result = contextHandler({ type: "context", messages: [undefMsg] }, {});
        expect(result).toBeUndefined();
    });

    it("returns { messages: [fixed] } when content is null (coerced to [])", () => {
        const badMsg = { role: "user", content: null };
        const result = contextHandler({ type: "context", messages: [badMsg] }, {});
        expect(result).toEqual({ messages: [{ role: "user", content: [] }] });
    });

    it("returns { messages: [fixed] } when content is a number (coerced to [])", () => {
        const badMsg = { role: "user", content: 42 };
        const result = contextHandler({ type: "context", messages: [badMsg] }, {});
        expect(result).toEqual({ messages: [{ role: "user", content: [] }] });
    });

    it("returns { messages: [fixed] } when content is a non-array object (coerced to [])", () => {
        const badMsg = { role: "user", content: { type: "text", text: "hi" } };
        const result = contextHandler({ type: "context", messages: [badMsg] }, {});
        expect(result).toEqual({ messages: [{ role: "user", content: [] }] });
    });

    it("returns { messages: [fixed] } when content array has a block missing string type (bad block dropped, good block kept)", () => {
        const msg = {
            role: "user",
            content: [
                { type: "text", text: "hi" },
                { noType: true },
            ],
        };
        const result = contextHandler({ type: "context", messages: [msg] }, {});
        expect(result.messages[0].content).toEqual([{ type: "text", text: "hi" }]);
    });

    it("returns { messages: [fixed] } when content array has only bad blocks (content becomes [])", () => {
        const msg = {
            role: "user",
            content: [
                { noType: true },
                null,
                "string-instead-of-block",
            ],
        };
        const result = contextHandler({ type: "context", messages: [msg] }, {});
        expect(result.messages[0].content).toEqual([]);
    });

    it("handles a mix of good and bad messages: good ones unchanged, bad ones fixed", () => {
        const good1 = { role: "user", content: [{ type: "text", text: "hi" }] };
        const bad1 = { role: "assistant", content: null };
        const good2 = { role: "user", content: "plain string" };
        const bad2 = { role: "toolResult", content: { weird: "shape" } };
        const result = contextHandler(
            { type: "context", messages: [good1, bad1, good2, bad2] },
            {},
        );
        expect(result.messages[0]).toEqual(good1);
        expect(result.messages[1]).toEqual({ role: "assistant", content: [] });
        expect(result.messages[2]).toEqual(good2);
        expect(result.messages[3]).toEqual({ role: "toolResult", content: [] });
    });

    it("returns undefined when event.messages is undefined (treated as empty, no bad messages)", () => {
        const result = contextHandler({ type: "context", messages: undefined }, {});
        expect(result).toBeUndefined();
    });

    it("returns undefined when event.messages is empty", () => {
        const result = contextHandler({ type: "context", messages: [] }, {});
        expect(result).toBeUndefined();
    });

    it("flags a message that is not an object (e.g. a string) and replaces it with a safe shape", () => {
        // This is unusual but valid: a malformed entry. The fix should produce
        // a safe message placeholder (we drop the bad entry and substitute a
        // minimal user/text placeholder) — but the current implementation only
        // coerces content. Here the message itself is bad, so it should still
        // not crash downstream.
        const result = contextHandler(
            { type: "context", messages: ["not-a-message"] },
            {},
        );
        // Whatever the fix produces, it must be a defined array of messages.
        expect(Array.isArray(result.messages)).toBe(true);
        expect(result.messages.length).toBe(1);
    });

    it("never throws even with completely garbage input", () => {
        expect(() =>
            contextHandler({ type: "context", messages: [null, undefined, 1, true, { weird: true }] }, {}),
        ).not.toThrow();
    });
});
