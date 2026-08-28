import { describe, expect, it, vi } from "vitest";

import { box, source } from "../src/reactive";
import { flush, track } from "./track";

describe(source, () => {
    it("reads straight through and connects nothing until a reader tracks it", () => {
        const connect = vi.fn<() => () => void>(() => () => {});
        const value = source(() => "initial", connect);

        // An untracked read is allowed — it just never opens the source.
        expect(value.current).toBe("initial");
        expect(connect).not.toHaveBeenCalled();

        const reader = track(() => value.current);

        expect(connect).toHaveBeenCalledTimes(1);
        expect(reader.seen).toStrictEqual(["initial"]);

        reader.stop();
    });

    it("reports the source's current truth, not a copy taken when it was built", () => {
        // The reason `read` is a getter: a source that already knows its own
        // value (`client.connectionStatus()`, `getAuthToken()`) can move between
        // the handle being built and the first read, and there is no cache here
        // to go stale against it.
        let truth = "before";
        const value = source(
            () => truth,
            () => () => {},
        );

        truth = "after";

        expect(value.current).toBe("after");
        expect(track(() => value.current).seen).toStrictEqual(["after"]);
    });

    it("re-runs its readers whenever connect signals a change, and tears down with the last of them", () => {
        const teardown = vi.fn<() => void>();
        let truth = "initial";
        let signal: (() => void) | undefined;

        const value = source(
            () => truth,
            (update) => {
                signal = update;

                return teardown;
            },
        );

        const reader = track(() => value.current);

        truth = "first";
        signal?.();
        flush();
        truth = "second";
        signal?.();
        flush();

        expect(reader.seen).toStrictEqual(["initial", "first", "second"]);
        expect(teardown).not.toHaveBeenCalled();

        reader.stop();

        expect(teardown).toHaveBeenCalledTimes(1);
    });

    it("connects once for several readers and tears down only after the last detaches", () => {
        const connect = vi.fn<() => () => void>(() => () => {});
        const value = source(() => 0, connect);

        const first = track(() => value.current);
        const second = track(() => value.current);

        expect(connect).toHaveBeenCalledTimes(1);

        first.stop();
        second.stop();

        expect(connect).toHaveBeenCalledTimes(1);
    });

    it("delivers a value pushed synchronously inside connect", () => {
        // `@lunora/client` replays a cached value synchronously on subscribe, so
        // the push lands before `connect` has returned its teardown.
        let truth: string | undefined;

        const value = source<string | undefined>(
            () => truth,
            (update) => {
                truth = "replayed";
                update();

                return () => {};
            },
        );

        const reader = track(() => value.current);

        expect(reader.last).toBe("replayed");

        reader.stop();
    });
});

describe(box, () => {
    it("does not re-run readers when a primitive is set to the value it already had", () => {
        // `svelte/store`'s writable skipped notifying on an unchanged primitive,
        // and handles depend on that: `agent`'s thread subscription pushes on any
        // row change and re-sets `status` to the same string each time, and
        // `voiceAgent` re-sets `audioLevel` per audio frame.
        const value = box("running");

        const reader = track(() => value.current);

        value.set("running");
        flush();

        expect(reader.seen).toStrictEqual(["running"]);

        value.set("idle");
        flush();

        expect(reader.seen).toStrictEqual(["running", "idle"]);

        reader.stop();
    });

    it("always re-runs readers for an object, which may have been mutated in place", () => {
        const first = { page: 1 };
        const value = box(first);

        const reader = track(() => value.current);

        // Same identity, but a store notified here and so does this — the
        // contents may have moved under us.
        value.set(first);
        flush();

        expect(reader.seen).toHaveLength(2);

        reader.stop();
    });

    it("reports the latest value whether or not anyone is reading", () => {
        const value = box("a");

        value.set("b");

        expect(value.current).toBe("b");

        const reader = track(() => value.current);

        expect(reader.seen).toStrictEqual(["b"]);

        value.set("c");
        flush();

        expect(reader.last).toBe("c");

        reader.stop();

        // A set with no reader attached is still observed by the next one.
        value.set("d");

        expect(track(() => value.current).seen).toStrictEqual(["d"]);
    });
});
