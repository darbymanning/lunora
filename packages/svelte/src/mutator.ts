import type { MutatorHandle } from "@lunora/client";
import { createMutatorRunner } from "@lunora/client";

import { box } from "./reactive";

/**
 * The reactive handle returned by {@link mutator} — the Svelte counterpart to
 * `@lunora/react`'s `useMutator`. `error`/`isError`/`pending` are reactive
 * getters: read them off the handle rather than destructuring.
 */
export interface MutatorState<TArgs> {
    /** The latest invocation's error, or `undefined`. */
    readonly error: Error | undefined;
    /** `true` when the latest invocation rejected. */
    readonly isError: boolean;
    /** Run the mutator; resolves once the write is persisted, rejects on failure. */
    mutate: (args: TArgs) => Promise<void>;
    /** `true` while ANY invocation from this handle is in flight (ref-counted, so overlapping calls compose). */
    readonly pending: boolean;
    /** Clear the latest `error` back to idle. */
    reset: () => void;
}

/**
 * Ergonomic `{ mutate, pending, error, isError, reset }` wrapper over a bound
 * custom-mutator handle from `@lunora/db`'s `bindMutators` — the Svelte
 * equivalent of `@lunora/react`'s `useMutator`. The optimistic overlay and
 * server-authoritative push are owned by the bound handle (and TanStack DB's
 * optimistic-transaction layer rebases pending overlays on every sync tick);
 * this helper only surfaces the in-flight/error lifecycle. Reads stay on the
 * existing TanStack `useLiveQuery`; no new query handle is needed.
 *
 * `pending` is ref-counted across overlapping invocations of THIS handle, so it
 * clears only once every concurrent call has settled.
 */
export const mutator = <TArgs = Record<string, unknown>>(handle: MutatorHandle<TArgs>): MutatorState<TArgs> => {
    const error = box<Error | undefined>(undefined);
    const pending = box(false);

    const { mutate, reset } = createMutatorRunner(handle, {
        setError: (value) => {
            error.set(value);
        },
        setPending: (value) => {
            pending.set(value);
        },
    });

    return {
        get error() {
            return error.current;
        },
        get isError() {
            return error.current !== undefined;
        },
        mutate,
        get pending() {
            return pending.current;
        },
        reset,
    };
};

export type { MutatorHandle, MutatorTransaction } from "@lunora/client";
