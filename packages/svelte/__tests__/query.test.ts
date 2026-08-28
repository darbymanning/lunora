import type { FunctionReference, LunoraClient, SubscriptionErrorCallback } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import { query } from "../src/query";
import { flush, track } from "./track";

const fnRef = { __lunoraRef: "messages:list" } as unknown as FunctionReference;
const args = { room: "general" } as unknown;

const createFakeClient = () => {
    const unsubscribe = vi.fn<() => void>();
    let lastCallback: ((value: unknown) => void) | undefined;
    let lastOnError: ((error: { message: string }) => void) | undefined;

    const subscribe = vi.fn<
        (function_: unknown, args: unknown, callback: (value: unknown) => void, options?: { onError?: (error: { message: string }) => void }) => () => void
    >((_function, _args, callback, options) => {
        lastCallback = callback;
        lastOnError = options?.onError;

        return unsubscribe;
    });

    const client = { subscribe } as unknown as LunoraClient;

    return {
        client,
        emit: (value: unknown) => lastCallback?.(value),
        emitError: (message: string) => lastOnError?.({ message }),
        subscribe,
        unsubscribe,
    };
};

describe(query, () => {
    it("is undefined before any value and opens no subscription until a reader tracks it", () => {
        const { client, subscribe } = createFakeClient();

        const handle = query(client, fnRef, args);

        // An untracked read (SSR, or a plain function) opens nothing.
        expect(handle.current).toBeUndefined();
        expect(subscribe).not.toHaveBeenCalled();

        const reader = track(() => handle.current);

        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(reader.last).toBeUndefined();

        reader.stop();
    });

    it("subscribes against the client on the first reader and unsubscribes when the last one leaves", () => {
        const { client, subscribe, unsubscribe } = createFakeClient();
        const handle = query(client, fnRef, args, { shardKey: "general" });

        const reader = track(() => handle.current);

        expect(subscribe).toHaveBeenCalledTimes(1);

        const [passedFunction, passedArgs, , options] = subscribe.mock.calls[0]!;

        expect(passedFunction).toBe(fnRef);
        expect(passedArgs).toBe(args);
        expect(options).toMatchObject({ shardKey: "general" });

        reader.stop();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("re-runs its readers on every server delta", () => {
        const { client, emit } = createFakeClient();
        const handle = query(client, fnRef, args);

        const reader = track(() => handle.current);

        emit([{ id: 1 }]);
        flush();
        emit([{ id: 1 }, { id: 2 }]);
        flush();

        expect(reader.seen).toStrictEqual([undefined, [{ id: 1 }], [{ id: 1 }, { id: 2 }]]);

        reader.stop();
    });

    it("opens no subscription and stays undefined when args is 'skip'", () => {
        const { client, subscribe } = createFakeClient();

        const handle = query(client, fnRef, "skip");

        const reader = track(() => handle.current);

        // The shared query state machine short-circuits the skip sentinel: no
        // socket opens and the value stays undefined (fires the onReset sink).
        expect(subscribe).not.toHaveBeenCalled();
        expect(reader.last).toBeUndefined();

        reader.stop();
    });

    it("forwards subscription errors to the onError option", () => {
        const { client, emitError } = createFakeClient();
        const onError = vi.fn<SubscriptionErrorCallback>();
        const handle = query(client, fnRef, args, { onError });

        const reader = track(() => handle.current);

        emitError("subscription failed");

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: "subscription failed" });

        reader.stop();
    });

    it("gives a handle rebuilt for new args its own subscription, and releases the old one", () => {
        // The runes replacement for reactive args: rebuild the handle inside a
        // `$derived.by`. Each build subscribes on its own first tracked read, and
        // the one whose reader has gone away is released.
        const { client, subscribe, unsubscribe } = createFakeClient();

        const general = track(() => query(client, fnRef, { room: "general" }).current);

        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(subscribe.mock.calls[0]?.[1]).toStrictEqual({ room: "general" });

        const random = track(() => query(client, fnRef, { room: "random" }).current);

        expect(subscribe).toHaveBeenCalledTimes(2);
        expect(subscribe.mock.calls[1]?.[1]).toStrictEqual({ room: "random" });

        general.stop();

        expect(unsubscribe).toHaveBeenCalledTimes(1);

        random.stop();

        expect(unsubscribe).toHaveBeenCalledTimes(2);
    });
});
