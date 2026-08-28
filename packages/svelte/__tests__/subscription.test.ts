import type { FunctionReference, LunoraClient } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import { subscription } from "../src/subscription";
import { flush, track } from "./track";

const fnRef = { __lunoraRef: "messages:subscribe" } as unknown as FunctionReference;
const args = { channelId: "c1" } as unknown;

const createFakeClient = () => {
    const unsubscribeSpy = vi.fn<() => void>();
    let lastCallback: ((value: unknown) => void) | undefined;
    let lastOnError: ((error: { message: string }) => void) | undefined;

    const subscribeSpy = vi.fn<
        (function_: unknown, args: unknown, callback: (value: unknown) => void, options?: { onError?: (error: { message: string }) => void }) => () => void
    >((_fn, _args, callback, options) => {
        lastCallback = callback;
        lastOnError = options?.onError;

        return unsubscribeSpy;
    });

    const client = { subscribe: subscribeSpy } as unknown as LunoraClient;

    return {
        client,
        emit: (value: unknown) => lastCallback?.(value),
        emitError: (message: string) => lastOnError?.({ message }),
        subscribeSpy,
        unsubscribeSpy,
    };
};

describe(subscription, () => {
    it("data is undefined before any push", () => {
        const { client } = createFakeClient();
        const handle = subscription(client, fnRef, args);

        // The handle is lazy — no subscription until the first tracked read.
        const reader = track(() => handle.data);

        expect(handle.data).toBeUndefined();

        reader.stop();
    });

    it("opens the subscription on the first tracked read and closes it when the last reader leaves", () => {
        const { client, subscribeSpy, unsubscribeSpy } = createFakeClient();
        const handle = subscription(client, fnRef, args, { shardKey: "c1" });

        const reader = track(() => handle.data);

        expect(subscribeSpy).toHaveBeenCalledTimes(1);

        reader.stop();

        expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    });

    it("delivers server pushes to readers of data", () => {
        const { client, emit } = createFakeClient();
        const handle = subscription(client, fnRef, args);

        const reader = track(() => handle.data);

        emit([{ id: "1" }]);
        flush();
        emit([{ id: "1" }, { id: "2" }]);
        flush();

        expect(reader.seen).toStrictEqual([undefined, [{ id: "1" }], [{ id: "1" }, { id: "2" }]]);

        reader.stop();
    });

    it("opens no subscription when args is 'skip'", () => {
        const { client, subscribeSpy } = createFakeClient();
        const handle = subscription(client, fnRef, "skip");

        const reader = track(() => handle.data);

        expect(subscribeSpy).not.toHaveBeenCalled();

        reader.stop();
    });

    it("routes a subscription error into the error store and the onError callback", () => {
        const { client, emitError } = createFakeClient();
        const onError = vi.fn<(error: Error) => void>();
        const handle = subscription(client, fnRef, args, { onError });

        // Subscribe both stores so the data store's start callback wires onError.
        const dataReader = track(() => handle.data);
        const errorReader = track(() => handle.error);

        emitError("boom");

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);

        const captured = handle.error;

        expect(captured).toBeInstanceOf(Error);
        expect(captured?.message).toBe("boom");

        dataReader.stop();
        errorReader.stop();
    });

    it("clears the error store once a healthy value arrives after an error", () => {
        const { client, emit, emitError } = createFakeClient();
        const handle = subscription(client, fnRef, args);

        const dataReader = track(() => handle.data);
        const errorReader = track(() => handle.error);

        emitError("transient");

        expect(handle.error).toBeInstanceOf(Error);

        emit([{ id: "1" }]);

        // A fresh server value marks the subscription healthy again.
        expect(handle.error).toBeUndefined();
        expect(handle.data).toStrictEqual([{ id: "1" }]);

        dataReader.stop();
        errorReader.stop();
    });

    it("holds the error while any reader remains, and clears it once the last one detaches", () => {
        const { client, emitError } = createFakeClient();
        const handle = subscription(client, fnRef, args);

        const dataReader = track(() => handle.data);
        const errorReader = track(() => handle.error);

        emitError("boom");

        expect(handle.error).toBeInstanceOf(Error);

        // `data` and `error` share one subscription, so dropping one reader does
        // not tear it down — the error is still the live state of the channel.
        dataReader.stop();

        expect(handle.error).toBeInstanceOf(Error);

        // The last reader leaving closes the subscription and clears the error,
        // so a later read re-opens from a clean slate.
        errorReader.stop();

        expect(handle.error).toBeUndefined();
    });
});
