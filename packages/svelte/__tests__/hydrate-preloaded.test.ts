import type { LunoraClient, Preloaded } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import { hydratePreloaded } from "../src/hydrate-preloaded";
import { flush, track } from "./track";

/**
 * A minimal stand-in for the parts of `LunoraClient` the adapter touches.
 * `subscribe` records its callback and returns a spy-able unsubscribe.
 */
const createFakeClient = () => {
    const unsubscribe = vi.fn<() => void>();
    let lastCallback: ((value: unknown) => void) | undefined;

    const subscribe = vi.fn<(function_: unknown, args: unknown, callback: (value: unknown) => void, options?: { shardKey?: string }) => () => void>(
        (_function, _args, callback) => {
            lastCallback = callback;

            return unsubscribe;
        },
    );

    const client = { subscribe } as unknown as LunoraClient;

    return {
        client,
        emit: (value: unknown) => lastCallback?.(value),
        subscribe,
        unsubscribe,
    };
};

const makePreloaded = <T>(value: T): Preloaded<T> => {
    const token: Preloaded<T> = {
        __lunoraPreloaded: true,
        args: { room: "general" },
        functionPath: "messages:list",
        shardKey: "general",
        value,
    };

    return token;
};

describe(hydratePreloaded, () => {
    it("yields the preloaded value synchronously on first read (no async, no flash)", () => {
        const { client } = createFakeClient();
        const preloaded = makePreloaded([{ id: 1, text: "hello" }]);

        // An untracked read is synchronous — the seeded value must be there
        // immediately, before any microtask or subscription callback runs.
        expect(hydratePreloaded(preloaded, client).current).toStrictEqual([{ id: 1, text: "hello" }]);
    });

    it("does not open a subscription for an untracked read (the SSR path)", () => {
        const { client, subscribe } = createFakeClient();

        expect(hydratePreloaded(makePreloaded("seed"), client).current).toBe("seed");

        // Nothing tracked the read, so the start callback never ran.
        expect(subscribe).not.toHaveBeenCalled();
    });

    it("attaches the live subscription on the first tracked read and re-runs on deltas", () => {
        const { client, emit, subscribe, unsubscribe } = createFakeClient();
        const handle = hydratePreloaded(makePreloaded("seed"), client);

        const reader = track(() => handle.current);

        // First value is the synchronous seed; the tracked read opened the WS sub.
        expect(reader.seen[0]).toBe("seed");
        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(subscribe.mock.calls[0]?.[0]).toStrictEqual({ __lunoraRef: "messages:list" });

        // A server delta flows through.
        emit("live update");
        flush();

        expect(reader.last).toBe("live update");

        // Dropping the last reader closes the underlying subscription.
        reader.stop();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
});
