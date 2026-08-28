import { flushSync } from "svelte";
import { toStore } from "svelte/store";

/** A reader attached to a runes handle, standing in for a component reading it. */
export interface Tracked<T> {
    /** The most recent value the reader observed. */
    readonly last: T;
    /** Every value the reader observed, oldest first, starting with the initial one. */
    seen: T[];
    /** Detach the reader. This is what releases the handle's subscription. */
    stop: () => void;
}

/**
 * Attach a reader to a runes handle, the way a component's template does.
 *
 * The primitives subscribe on their first *tracked* read and release once every
 * reader is gone, so a test that only touches `.current` observes nothing and
 * opens nothing. `toStore` wraps the read in an effect root — the same tracking
 * a template gives it — and `stop()` destroys that root, which is what asserts
 * teardown.
 *
 * Effects settle on a microtask, so `flushSync` is called after the attach, on
 * every `stop()`, and must be called by the test after anything that pushes a
 * new value (`flush()` below, or `flushSync()` directly).
 */
export const track = <T>(read: () => T): Tracked<T> => {
    const seen: T[] = [];

    const unsubscribe = toStore(read).subscribe((value) => {
        seen.push(value);
    });

    flushSync();

    return {
        get last(): T {
            return seen.at(-1) as T;
        },
        seen,
        stop: () => {
            unsubscribe();
            flushSync();
        },
    };
};

/** Settle pending effects so the values pushed since the last flush reach every reader. */
export const flush = (): void => {
    flushSync();
};
