import { createSubscriber } from "svelte/reactivity";

/** A read-only reactive value. Read `.current` in a component, `$derived`, or `$effect` and it stays live. */
interface ReactiveValue<T> {
    readonly current: T;
}

/** What a `connect` callback returns: the teardown for whatever it opened, or nothing. */
type Teardown = (() => void) | undefined;

/**
 * Expose an external source as a reactive value — the shape Svelte's own
 * `MediaQuery` uses: mark the dependency, then read the source.
 *
 * `read` returns the current truth on every read, so there is no copy to keep in
 * sync; `connect` opens the source, calls `update` whenever the truth changes,
 * and returns its teardown. `connect` runs on the first *tracked* read (from a
 * template, a `$derived`, or an `$effect`) and its teardown runs once every
 * effect that read it is destroyed — the lazy subscribe / auto-release lifecycle
 * every primitive here depends on. An untracked read (during SSR, or from a
 * plain function) opens nothing and just reports what `read` says.
 *
 * A push-only source — one that hands you values but cannot be asked for the
 * current one — keeps its own variable and closes over it in `read`. That cache
 * belongs to the call site that needs it, not to every caller.
 */
const source = <T>(read: () => T, connect: (update: () => void) => Teardown): ReactiveValue<T> => {
    const subscribe = createSubscriber(connect);

    return {
        get current() {
            subscribe();

            return read();
        },
    };
};

/**
 * `svelte/store`'s notify-on-set rule, which `box` keeps: an unchanged primitive
 * is not a change, but an object or function always is, since it may have been
 * mutated in place. Re-implemented rather than imported so nothing here depends
 * on `svelte/store`.
 */
const changed = (a: unknown, b: unknown): boolean => {
    // NaN is the one value not equal to itself, so `!==` would call every write
    // a change. `NaN` to `NaN` is not one.
    if (Number.isNaN(a)) {
        return !Number.isNaN(b);
    }

    // An object or function is always treated as changed: it may have been
    // mutated in place, which identity cannot see.
    return a !== b || (a !== null && typeof a === "object") || typeof a === "function";
};

/**
 * Reactive state the handle itself owns and sets imperatively — what `$state`
 * would be if this package were compiled. Each box is its own dependency, so a
 * reader of `pending` is not re-run by a write to `data`, and a hot field like
 * `audioLevel` does not drag every other reader along at frame rate.
 */
const box = <T>(initial: T): ReactiveValue<T> & { set: (value: T) => void } => {
    let value = initial;
    let update: (() => void) | undefined;

    const subscribe = createSubscriber((invalidate) => {
        update = invalidate;

        return () => {
            update = undefined;
        };
    });

    return {
        get current() {
            subscribe();

            return value;
        },
        set(next: T) {
            if (changed(value, next)) {
                value = next;
                // `update` is undefined when nothing is reading: the next tracked
                // read re-runs `connect` and reports this value anyway.
                update?.();
            }
        },
    };
};

export type { ReactiveValue };
export { box, source };
