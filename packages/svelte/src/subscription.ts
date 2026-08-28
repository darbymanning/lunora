import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf } from "@lunora/client";
import { createQuerySubscription } from "@lunora/client/query";
import { createSubscriber } from "svelte/reactivity";

import { getLunoraClient } from "./context";
import { isFunctionReference } from "./is-function-reference";

interface SubscriptionOptions {
    onError?: (error: Error) => void;
    shardKey?: string;
}

interface SubscriptionHandle<T> {
    /** The latest server-pushed value (`undefined` until the first push). */
    readonly data: T | undefined;
    /** The latest subscription error (`undefined` when healthy). */
    readonly error: Error | undefined;
}

/**
 * Open a live subscription against the Lunora backend. `data` reports every
 * server push; `error` reports the last subscription error. Both are lazy and
 * share one subscription: it opens on the first tracked read of either and
 * tears down once every effect that read it is destroyed.
 *
 * Passing `"skip"` as `args` keeps the handle but leaves the subscription
 * dormant (`data` stays `undefined`). Pass an explicit `client` as the first
 * argument to bypass the ambient context (useful in tests).
 *
 * For args that change, build the handle inside a `$derived.by`, as `query`
 * documents.
 */
function subscription<F extends FunctionReference>(function_: F, args: ArgsOf<F> | "skip", options?: SubscriptionOptions): SubscriptionHandle<ReturnOf<F>>;
function subscription<F extends FunctionReference>(
    client: LunoraClient,
    function_: F,
    args: ArgsOf<F> | "skip",
    options?: SubscriptionOptions,
): SubscriptionHandle<ReturnOf<F>>;
function subscription<F extends FunctionReference>(
    clientOrFunction: F | LunoraClient,
    functionOrArgs: ArgsOf<F> | F | "skip",
    argsOrOptions?: ArgsOf<F> | SubscriptionOptions | "skip",
    maybeOptions?: SubscriptionOptions,
): SubscriptionHandle<ReturnOf<F>> {
    // Resolve overloads: when the second argument is a FunctionReference, the
    // first must be an explicit LunoraClient; otherwise use the ambient context.
    const hasExplicitClient = !isFunctionReference(clientOrFunction);
    const client = hasExplicitClient ? clientOrFunction : getLunoraClient();
    const functionRef = (hasExplicitClient ? functionOrArgs : clientOrFunction) as F;
    const args = (hasExplicitClient ? argsOrOptions : functionOrArgs) as ArgsOf<F> | "skip";
    const options = (hasExplicitClient ? maybeOptions : (argsOrOptions as SubscriptionOptions | undefined)) ?? {};

    const { shardKey, onError } = options;

    let data: ReturnOf<F> | undefined;
    let error: Error | undefined;

    // One source behind both getters, so reading either opens the subscription
    // and an error is observable even by a caller that only reads `error`.
    const track = createSubscriber((invalidate) => {
        // `createQuerySubscription` owns the `"skip"` sentinel: on skip it fires
        // `onReset` (clearing `data`) and returns a no-op teardown without opening
        // a socket — so the reset path below is reachable, unlike a local early
        // return that would make it dead code.
        const stop = createQuerySubscription(
            client,
            functionRef,
            args,
            {
                onData: (value: ReturnOf<F>) => {
                    data = value;
                    error = undefined;
                    invalidate();
                },
                onError: (subscriptionError) => {
                    error = new Error(subscriptionError.message);
                    invalidate();
                    onError?.(error);
                },
                onReset: () => {
                    data = undefined;
                    invalidate();
                },
            },
            { shardKey },
        );

        return () => {
            stop();
            error = undefined;
        };
    });

    return {
        get data() {
            track();

            return data;
        },
        get error() {
            track();

            return error;
        },
    };
}

export type { SubscriptionHandle, SubscriptionOptions };
export { subscription };
