import type { ActionCallOptions, ArgsOf, FunctionReference, LunoraClient, ReturnOf } from "@lunora/client";
import { createCallRunner } from "@lunora/client";

import { getLunoraClient } from "./context";
import { box } from "./reactive";

/**
 * The reactive handle returned by {@link action} — the Svelte counterpart to
 * React's `useAction`. `data`/`error`/`pending` are reactive getters: read them
 * off the handle rather than destructuring, or the value is snapshotted.
 */
export interface ActionHandle<F extends FunctionReference> {
    /**
     * Run the action. Resolves with the server result and rejects on failure
     * (errors propagate — there is no swallowing).
     */
    call: (args: ArgsOf<F>, options?: ActionCallOptions) => Promise<ReturnOf<F>>;
    /** The latest invocation's resolved value, or `undefined` before the first success. */
    readonly data: ReturnOf<F> | undefined;
    /** The latest invocation's error, or `undefined`. */
    readonly error: Error | undefined;

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
 * Create an {@link ActionHandle} for an action reference. The Svelte
 * counterpart to React's `useAction`.
 *
 * **Narrower than `mutation` on purpose:** no `optimistic` /
 * `optimisticUpdate`. An optimistic update patches the subscription cache on the
 * assumption a write will land; an action is not a write — it runs in the
 * Worker, may call a third party, and has no declared effect on any query.
 *
 * `data`/`error` follow the adapter-wide contract: both track the LATEST
 * invocation (an earlier call settling later cannot clobber a newer one), a
 * success clears `error`, and a failure leaves the previous `data` in place.
 * `reset()` clears both; it does not cancel an in-flight call.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published
 * by `setLunoraClient`.
 */
export function action<F extends FunctionReference>(function_: F): ActionHandle<F>;
export function action<F extends FunctionReference>(client: LunoraClient, function_: F): ActionHandle<F>;
export function action<F extends FunctionReference>(clientOrFunction: LunoraClient | F, maybeFunction?: F): ActionHandle<F> {
    const hasExplicitClient = maybeFunction !== undefined;
    const client = hasExplicitClient ? (clientOrFunction as LunoraClient) : getLunoraClient();
    const functionRef = (hasExplicitClient ? maybeFunction : clientOrFunction) as F;

    const data = box<ReturnOf<F> | undefined>(undefined);
    const error = box<Error | undefined>(undefined);
    const pending = box(false);

    const call = createCallRunner((args: ArgsOf<F>, options?: ActionCallOptions) => client.action(functionRef, args, options), {
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
    });

    const reset = (): void => {
        data.set(undefined);
        error.set(undefined);
    };

    return {
        call,
        get data() {
            return data.current;
        },
        get error() {
            return error.current;
        },
        get pending() {
            return pending.current;
        },
        reset,
    };
}
