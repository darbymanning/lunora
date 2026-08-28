import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, SubscriptionErrorCallback } from "@lunora/client";
import { createQuerySubscription } from "@lunora/client/query";

import { getLunoraClient } from "./context";
import { isFunctionReference } from "./is-function-reference";
import type { ReactiveValue } from "./reactive";
import { source } from "./reactive";

/** Options accepted by {@link query}. */
export interface QueryOptions {
    /** Called when the underlying subscription reports an error. */
    onError?: SubscriptionErrorCallback;

    /** Route to a specific shard when the target function is `.shardBy(...)`-partitioned. */
    shardKey?: string;
}

/**
 * The handle returned by {@link query}: `current` is the latest server value
 * (`undefined` until the first response lands, mirroring React's `useQuery`).
 */
export type QueryHandle<F extends FunctionReference> = ReactiveValue<ReturnOf<F> | undefined>;

/**
 * Open a live query. Read `handle.current` in a component, a `$derived`, or an
 * `$effect` and it stays current: a WS subscription attaches on that first
 * tracked read and the value re-runs every reader on each server delta — the
 * Svelte equivalent of React's `useQuery`.
 *
 * The subscription is opened lazily (on the first tracked read of `current`)
 * and torn down once every effect that read it is destroyed — so a handle
 * that's never read opens no socket, a component that unmounts releases its
 * subscription, and a server render (where nothing tracks) opens nothing.
 * Sharing one handle across several components shares a single underlying
 * subscription (the `LunoraClient` de-dupes by `(fn, args, shardKey)`).
 *
 * Pass `"skip"` as `args` to keep the handle but leave the subscription dormant
 * (`current` stays `undefined`, no socket opens) — useful for a query gated on
 * auth or a route param, matching React/Vue/Solid's `useQuery`.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published
 * by `setLunoraClient` (which must therefore be called during component init,
 * before this runs).
 *
 * For args that change, create the handle inside a `$derived.by` — each change
 * builds a fresh handle, and the subscription the previous one held is released
 * when the reading effect re-runs:
 *
 * ```svelte
 * let channelId = $state("general");
 * const messages = $derived.by(() => query(api.messages.list, { channelId }));
 * // markup: {#each messages.current ?? [] as m (m._id)}
 * ```
 */
export function query<F extends FunctionReference>(function_: F, args: ArgsOf<F> | "skip", options?: QueryOptions): QueryHandle<F>;
export function query<F extends FunctionReference>(client: LunoraClient, function_: F, args: ArgsOf<F> | "skip", options?: QueryOptions): QueryHandle<F>;
export function query<F extends FunctionReference>(
    clientOrFunction: LunoraClient | F,
    functionOrArguments: ArgsOf<F> | F | "skip",
    argumentsOrOptions?: ArgsOf<F> | QueryOptions | "skip",
    maybeOptions?: QueryOptions,
): QueryHandle<F> {
    // Resolve the overload: when the first arg is a function reference (carries
    // `__lunoraRef`), the ambient context client is used; otherwise the explicit
    // client was passed first.
    const hasExplicitClient = !isFunctionReference(clientOrFunction);
    const client = hasExplicitClient ? clientOrFunction : getLunoraClient();
    const functionRef = (hasExplicitClient ? functionOrArguments : clientOrFunction) as F;
    const args = (hasExplicitClient ? argumentsOrOptions : functionOrArguments) as ArgsOf<F> | "skip";
    const options = (hasExplicitClient ? maybeOptions : (argumentsOrOptions as QueryOptions | undefined)) ?? {};

    // A subscription only ever pushes, so this handle keeps the latest frame.
    let latest: ReturnOf<F> | undefined;

    return source<ReturnOf<F> | undefined>(
        () => latest,
        // The shared `@lunora/client/query` state machine owns the subscribe +
        // cleanup: it replays the last value synchronously when one exists and
        // pushes every subsequent delta out, and its returned teardown closes the
        // WS subscription once the last reader detaches.
        (update) =>
            createQuerySubscription<F>(
                client,
                functionRef,
                args,
                {
                    onData: (value: ReturnOf<F>) => {
                        latest = value;
                        update();
                    },
                    onError: options.onError,
                    // `args === "skip"` short-circuits inside the shared helper and
                    // fires this reset — clear any prior value so a handle that is
                    // skipped does not retain stale data.
                    onReset: () => {
                        latest = undefined;
                        update();
                    },
                },
                { shardKey: options.shardKey },
            ),
    );
}
