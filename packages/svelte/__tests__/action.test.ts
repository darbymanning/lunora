import type { FunctionReference, LunoraClient } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import { action } from "../src/action";
import { flush, track } from "./track";

const fnRef = { __lunoraRef: "commands:run" } as unknown as FunctionReference;
const args = { command: "lunora" } as unknown;

describe(action, () => {
    it("forwards args and options to client.action and resolves the result", async () => {
        const actionFn = vi.fn<(function_: unknown, args: unknown, options?: { shardKey?: string }) => Promise<unknown>>().mockResolvedValue({ code: 0 });
        const client = { action: actionFn } as unknown as LunoraClient;

        const result = await action(client, fnRef).call(args, { shardKey: "project-1" });

        expect(result).toStrictEqual({ code: 0 });
        expect(actionFn).toHaveBeenCalledWith(fnRef, args, { shardKey: "project-1" });
    });

    it("flips pending true during the call and back to false after it settles", async () => {
        let resolveCall: (value: unknown) => void = () => {};
        const actionFn = vi.fn<() => Promise<unknown>>(
            () =>
                new Promise((resolve) => {
                    resolveCall = resolve;
                }),
        );
        const client = { action: actionFn } as unknown as LunoraClient;

        const handle = action(client, fnRef);

        expect(handle.pending).toBe(false);

        const inflight = handle.call(args);

        expect(handle.pending).toBe(true);

        resolveCall({ code: 0 });
        await inflight;

        expect(handle.pending).toBe(false);
    });

    // Ref-counted `pending` across overlapping calls lives entirely in
    // `createCallRunner` and is pinned there; what only a Svelte test can prove
    // is that the runner's writes re-run a reader, which is what reading
    // `handle.data` in a template compiles down to.
    it("re-runs readers of data and pending", async () => {
        const actionFn = vi.fn<() => Promise<unknown>>().mockResolvedValue({ code: 0 });
        const client = { action: actionFn } as unknown as LunoraClient;

        const handle = action(client, fnRef);

        const data = track(() => handle.data);
        const pending = track(() => handle.pending);

        await handle.call(args);
        flush();

        // Each reader records its initial value first, so everything after the
        // head is a real re-run.
        expect(data.seen).toStrictEqual([undefined, { code: 0 }]);
        expect(pending.seen).toStrictEqual([false, true, false]);

        data.stop();
        pending.stop();
    });

    it("keeps the previous data when a later call fails", async () => {
        const actionFn = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce({ code: 0 }).mockRejectedValueOnce(new Error("refused"));
        const client = { action: actionFn } as unknown as LunoraClient;

        const handle = action(client, fnRef);

        await handle.call(args);

        expect(handle.data).toStrictEqual({ code: 0 });

        await expect(handle.call(args)).rejects.toThrow("refused");

        // The adapter-wide contract: a failure sets `error` and leaves the last
        // successful `data` in place.
        expect(handle.error?.message).toBe("refused");
        expect(handle.data).toStrictEqual({ code: 0 });
    });

    it("records a normalized error, rejects, and clears pending", async () => {
        const actionFn = vi.fn<() => Promise<unknown>>().mockRejectedValue("refused");
        const client = { action: actionFn } as unknown as LunoraClient;

        const handle = action(client, fnRef);

        // A thrown non-Error is normalized, so a consumer can always read
        // `.message` rather than branching on what the server happened to throw.
        await expect(handle.call(args)).rejects.toThrow("refused");
        expect(handle.error).toBeInstanceOf(Error);
        expect(handle.pending).toBe(false);
    });

    it("reset clears data and error back to idle", async () => {
        const actionFn = vi.fn<() => Promise<unknown>>().mockResolvedValue({ code: 0 });
        const client = { action: actionFn } as unknown as LunoraClient;

        const handle = action(client, fnRef);

        await handle.call(args);

        expect(handle.data).toStrictEqual({ code: 0 });

        handle.reset();

        expect(handle.data).toBeUndefined();
    });
});
