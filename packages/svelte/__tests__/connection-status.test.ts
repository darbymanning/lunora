import type { ConnectionStatus, LunoraClient, Unsubscribe } from "@lunora/client";
import { describe, expect, it } from "vitest";

import { connectionStatus } from "../src/connection-status";
import { flush, track } from "./track";

/**
 * Minimal stand-in exposing just the connection-status surface the handle
 * touches. Records listeners so a test can drive transitions and assert the
 * listener is released when the last reader goes away.
 */
const makeFake = (initial: ConnectionStatus) => {
    let current = initial;
    const listeners = new Set<(status: ConnectionStatus) => void>();

    const client = {
        connectionStatus: () => current,
        onConnectionStatus: (listener: (status: ConnectionStatus) => void): Unsubscribe => {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
    } as unknown as LunoraClient;

    return {
        client,
        emit: (status: ConnectionStatus) => {
            current = status;

            for (const listener of listeners) {
                listener(status);
            }
        },
        listenerCount: () => listeners.size,
    };
};

describe(connectionStatus, () => {
    it("reports the current status and every transition to its readers", () => {
        const fake = makeFake("idle");
        const handle = connectionStatus(fake.client);

        const reader = track(() => handle.current);

        // The listener attached on the first tracked read.
        expect(fake.listenerCount()).toBe(1);

        fake.emit("connecting");
        flush();
        fake.emit("connected");
        flush();

        expect(reader.seen).toStrictEqual<ConnectionStatus[]>(["idle", "connecting", "connected"]);

        reader.stop();

        // The last reader left → the listener is released.
        expect(fake.listenerCount()).toBe(0);
    });

    it("reports the current status on an untracked read, attaching no listener", () => {
        const fake = makeFake("connected");

        expect(connectionStatus(fake.client).current).toBe("connected");
        expect(fake.listenerCount()).toBe(0);
    });
});
