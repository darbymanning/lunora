import type { FunctionReference, LunoraClient } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import { mutation } from "../src/mutation";

const fnRef = { __lunoraRef: "messages:send" } as unknown as FunctionReference;
const args = { text: "hi" } as unknown;

describe(mutation, () => {
    it("forwards args and options to client.mutation and resolves the result", async () => {
        const mutationFn = vi.fn<(function_: unknown, args: unknown, options?: { shardKey?: string }) => Promise<unknown>>().mockResolvedValue({ id: 1 });
        const client = { mutation: mutationFn } as unknown as LunoraClient;

        const result = await mutation(client, fnRef).mutate(args, { shardKey: "general" });

        expect(result).toStrictEqual({ id: 1 });
        expect(mutationFn).toHaveBeenCalledWith(fnRef, args, { shardKey: "general" });
    });

    it("flips pending true during the call and back to false after it settles", async () => {
        let resolveCall: (value: unknown) => void = () => {};
        const mutationFn = vi.fn<() => Promise<unknown>>(
            () =>
                new Promise((resolve) => {
                    resolveCall = resolve;
                }),
        );
        const client = { mutation: mutationFn } as unknown as LunoraClient;

        const handle = mutation(client, fnRef);

        expect(handle.pending).toBe(false);

        const inflight = handle.mutate(args);

        expect(handle.pending).toBe(true);

        resolveCall({ ok: true });
        await inflight;

        expect(handle.pending).toBe(false);
    });

    it("keeps pending true until the last overlapping call settles (ref-counted)", async () => {
        const resolvers: ((value: unknown) => void)[] = [];
        const mutationFn = vi.fn<() => Promise<unknown>>(
            () =>
                new Promise((resolve) => {
                    resolvers.push(resolve);
                }),
        );
        const client = { mutation: mutationFn } as unknown as LunoraClient;

        const handle = mutation(client, fnRef);
        const first = handle.mutate(args);
        const second = handle.mutate(args);

        expect(handle.pending).toBe(true);

        resolvers[0]?.(null);
        await first;

        // One call still in flight → still pending.
        expect(handle.pending).toBe(true);

        resolvers[1]?.(null);
        await second;

        expect(handle.pending).toBe(false);
    });
});
