import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf } from "@lunora/client";
import { createSubscriber } from "svelte/reactivity";

import { getLunoraClient } from "./context";
import { isFunctionReference } from "./is-function-reference";

/** The lifecycle of a stream the handle is observing. */
type StreamStatus = "complete" | "error" | "idle" | "streaming";

interface StreamOptions {
    /** Forwarded to `client.stream()` — caps the in-flight chunk buffer. */
    maxBuffer?: number;
    shardKey?: string;
}

interface StreamHandle<T> {
    /** Force-cancel the stream and resolve the iterator. Safe to call multiple times. */
    cancel: () => void;
    /** The chunks the server has pushed so far, in arrival order. */
    readonly chunks: ReadonlyArray<T>;
    /** The last stream error (`undefined` when healthy). */
    readonly error: Error | undefined;
    /** The stream lifecycle status. */
    readonly status: StreamStatus;

    /**
     * Stop the stream and release the iterator. Call in `onDestroy`
     * (`onDestroy(handle.teardown)`) when you consume the handle outside an
     * effect; when `chunks`/`status`/`error` are read reactively the stream
     * tears itself down as the last reader goes away.
     */
    teardown: () => void;
}

/**
 * Open a streaming query and expose its chunks, lifecycle status, and last
 * error. All three are lazy and share one stream: it opens on the first tracked
 * read of any of them and is cancelled once every effect that read it is
 * destroyed (its chunks reset on the next open).
 *
 * Passing `"skip"` as `args` keeps the handle but leaves the stream dormant
 * (`chunks` stays empty, `status` stays `"idle"`). The Svelte counterpart to
 * React's `useStream`.
 *
 * Pass an explicit `client` as the first argument to bypass the ambient context
 * (useful in tests), or omit it to resolve the client published by
 * `setLunoraClient`.
 */
function stream<F extends FunctionReference<"stream">>(function_: F, args: ArgsOf<F> | "skip", options?: StreamOptions): StreamHandle<ReturnOf<F>>;
function stream<F extends FunctionReference<"stream">>(
    client: LunoraClient,
    function_: F,
    args: ArgsOf<F> | "skip",
    options?: StreamOptions,
): StreamHandle<ReturnOf<F>>;
function stream<F extends FunctionReference<"stream">>(
    clientOrFunction: F | LunoraClient,
    functionOrArgs: ArgsOf<F> | F | "skip",
    argsOrOptions?: ArgsOf<F> | StreamOptions | "skip",
    maybeOptions?: StreamOptions,
): StreamHandle<ReturnOf<F>> {
    // Resolve overloads: when the second argument is a FunctionReference, the
    // first must be an explicit LunoraClient; otherwise use the ambient context.
    const hasExplicitClient = !isFunctionReference(clientOrFunction);
    const client = hasExplicitClient ? clientOrFunction : getLunoraClient();
    const functionRef = (hasExplicitClient ? functionOrArgs : clientOrFunction) as F;
    const args = (hasExplicitClient ? argsOrOptions : functionOrArgs) as ArgsOf<F> | "skip";
    const options = (hasExplicitClient ? maybeOptions : (argsOrOptions as StreamOptions | undefined)) ?? {};

    const { maxBuffer, shardKey } = options;

    let chunks: ReadonlyArray<ReturnOf<F>> = [];
    let status: StreamStatus = "idle";
    let error: Error | undefined;

    // The live cancel handle for the currently-open stream, so a manual `cancel()`
    // and the lazy source's teardown call into the same function.
    let cancelCurrent: (() => void) | undefined;

    const cancel = (): void => {
        cancelCurrent?.();
    };

    const track = createSubscriber((invalidate) => {
        // Reset for the (re-)opened stream.
        chunks = [];
        error = undefined;

        if (args === "skip") {
            status = "idle";

            return undefined;
        }

        status = "streaming";

        let active = true;
        const iterable = client.stream(functionRef, args, { maxBuffer, shardKey });
        const cancelIterable = (): void => {
            iterable.cancel();
        };

        cancelCurrent = cancelIterable;

        // Consume in a background async IIFE so the start callback stays
        // synchronous; the cancel handle is what the teardown uses. The IIFE
        // owns its own try/catch so any error already lands in the state; the
        // trailing `.catch` is a belt-and-braces guard that can never fire.
        (async () => {
            try {
                for await (const chunk of iterable) {
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `active` is flipped to `false` by the teardown closure between awaits; TS's static flow analysis can't see the async mutation, so this guard is real, not dead.
                    if (!active) {
                        return;
                    }

                    // Append immutably so consumers comparing by identity see a change.
                    chunks = [...chunks, chunk];
                    invalidate();
                }

                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `active` may have been flipped to `false` by the teardown closure while the iterator was awaiting; the guard is real, not dead.
                if (active) {
                    status = "complete";
                    invalidate();
                }
            } catch (streamError: unknown) {
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `active` may have been flipped to `false` by the teardown closure while the iterator was awaiting; the guard is real, not dead.
                if (!active) {
                    return;
                }

                error = streamError instanceof Error ? streamError : new Error(String(streamError));
                status = "error";
                invalidate();
            }
        })().catch(() => {
            // Unreachable: the IIFE's own try/catch already routes errors into the
            // handle's state. This satisfies no-floating-promises.
        });

        return () => {
            active = false;
            cancelIterable();

            if (cancelCurrent === cancelIterable) {
                cancelCurrent = undefined;
            }
        };
    });

    return {
        cancel,
        get chunks() {
            track();

            return chunks;
        },
        get error() {
            track();

            return error;
        },
        get status() {
            track();

            return status;
        },
        teardown: cancel,
    };
}

export type { StreamHandle, StreamOptions, StreamStatus };
export { stream };
