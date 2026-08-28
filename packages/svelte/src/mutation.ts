import type { ArgsOf, FunctionReference, LunoraClient, MutationCallOptions, ReturnOf } from "@lunora/client";
import { createCallRunner } from "@lunora/client";

import { getLunoraClient } from "./context";
import { box } from "./reactive";

/**
 * The reactive handle returned by {@link mutation} — the Svelte counterpart to
 * React's `useMutation`. `data`/`error`/`pending` are reactive getters: read
 * them off the handle (`send.pending`) rather than destructuring, or the value
 * is snapshotted and never updates.
 */
export interface MutationHandle<F extends FunctionReference> {
    /** The latest invocation's resolved value, or `undefined` before the first success. */
    readonly data: ReturnOf<F> | undefined;
    /** The latest invocation's error, or `undefined`. */
    readonly error: Error | undefined;

    /**
     * Run the mutation. Resolves with the server result and rejects on failure
     * (errors propagate — there is no swallowing). Optimistic updates passed in
     * `options` are applied and rolled back by the client against the live query
     * subscriptions, exactly as in the React adapter.
     */
    mutate: (args: ArgsOf<F>, options?: MutationCallOptions<unknown, unknown, ArgsOf<F>>) => Promise<ReturnOf<F>>;

    /**
     * `true` while any invocation from this handle is in flight. Ref-counted, so
     * overlapping calls compose and it only flips back to `false` once the last
     * one settles — read it to disable a button.
     */
    readonly pending: boolean;
    /** Clear `data`/`error` back to idle. */
    reset: () => void;
}

/**
 * Create an optimistic {@link MutationHandle} for a mutation reference. The
 * Svelte counterpart to React's `useMutation`. The ref-counted pending +
 * error-normalize orchestration is the shared `createCallRunner` from
 * `@lunora/client`; only the reactive state is adapter-specific.
 *
 * `data`/`error` follow the adapter-wide contract: both track the LATEST
 * invocation (an earlier call settling later cannot clobber a newer one), a
 * success clears `error`, and a failure leaves the previous `data` in place.
 * `reset()` clears both; it does not cancel an in-flight call.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published
 * by `setLunoraClient`.
 */
export function mutation<F extends FunctionReference>(function_: F): MutationHandle<F>;
export function mutation<F extends FunctionReference>(client: LunoraClient, function_: F): MutationHandle<F>;
export function mutation<F extends FunctionReference>(clientOrFunction: LunoraClient | F, maybeFunction?: F): MutationHandle<F> {
    const hasExplicitClient = maybeFunction !== undefined;
    const client = hasExplicitClient ? (clientOrFunction as LunoraClient) : getLunoraClient();
    const functionRef = (hasExplicitClient ? maybeFunction : clientOrFunction) as F;

    const data = box<ReturnOf<F> | undefined>(undefined);
    const error = box<Error | undefined>(undefined);
    const pending = box(false);

    const mutate = createCallRunner(
        (args: ArgsOf<F>, options?: MutationCallOptions<unknown, unknown, ArgsOf<F>>) => client.mutation(functionRef, args, options),
        {
            setError: (next) => {
                error.set(next);
            },
            setPending: (next) => {
                pending.set(next);
            },
            setResult: (result) => {
                data.set(result);
                error.set(undefined);
            },
        },
    );

    const reset = (): void => {
        data.set(undefined);
        error.set(undefined);
    };

    return {
        get data() {
            return data.current;
        },
        get error() {
            return error.current;
        },
        mutate,
        get pending() {
            return pending.current;
        },
        reset,
    };
}
