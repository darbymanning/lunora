import type { RateLimitConfig, RateLimitStatus, RateLimitValue } from "@lunora/ratelimit";
import { evaluate } from "@lunora/ratelimit";

import { isBrowser } from "../../../shared/is-browser";
import { box } from "./reactive";

export interface RateLimitOptions {
    /** Clock injection for tests. Defaults to `Date.now`. */
    now?: () => number;

    /**
     * Re-evaluation cadence in milliseconds while throttled, so `retryAfter`
     * ticks down and `disabled` flips back automatically. Defaults to `1000`.
     */
    tickMs?: number;
}

export interface RateLimitHandle {
    /** Would consuming `count` (default 1) succeed right now? Does not consume. */
    check: (count?: number) => boolean;
    /** Optimistically consume `count` (default 1) locally; mirrors the server algorithm. */
    consume: (count?: number) => RateLimitStatus;
    /** `true` while a single unit cannot be consumed. */
    readonly disabled: boolean;
    /** `true` while a single unit can be consumed. */
    readonly ok: boolean;
    /** Clear local accounting (e.g. after the server confirms a reset). */
    reset: () => void;
    /** Milliseconds until the next unit is available. `0` when `ok`. */
    readonly retryAfter: number;
    /** Stop the auto-tick interval. Call from `onDestroy` to prevent leaks. */
    teardown: () => void;
}

/**
 * Client-side mirror of a rate limit for instant UX — disable a button or show
 * a countdown without a round-trip. It runs the same token-bucket / fixed-window
 * math as `@lunora/ratelimit` on the server, so the prediction agrees with the
 * authoritative check; the server remains the source of truth.
 *
 * `config` is read on every call; pass a stable reference (module constant).
 * Read `ok`/`disabled`/`retryAfter` off the handle rather than destructuring, or
 * the value is snapshotted and never updates.
 *
 * Call `teardown()` when the component is destroyed to stop the auto-tick
 * interval (`onDestroy(handle.teardown)`).
 */
export const rateLimit = (config: RateLimitConfig, options: RateLimitOptions = {}): RateLimitHandle => {
    const now = options.now ?? Date.now;
    const tickMs = options.tickMs ?? 1000;

    // The bucket itself is never read reactively — `ok`/`disabled`/`retryAfter`
    // are a projection of it AND of the clock, and the clock moves without
    // anyone touching the bucket. So the projection is what lives in the box:
    // `refresh()` recomputes it, and every reader tracks the result.
    let value: RateLimitValue | undefined;

    const evaluateStatus = (count: number): RateLimitStatus => evaluate(config, value, { consume: false, count, now: now(), reserve: false }).status;

    const status = box<RateLimitStatus>(evaluateStatus(1));

    /** Recompute the projection. Called on every write and on each auto-tick. */
    const refresh = (): void => {
        status.set(evaluateStatus(1));
    };

    let intervalHandle: ReturnType<typeof setInterval> | undefined;

    const stopInterval = (): void => {
        if (intervalHandle !== undefined) {
            clearInterval(intervalHandle);
            intervalHandle = undefined;
        }
    };

    const startIntervalIfThrottled = (): void => {
        if (intervalHandle !== undefined || evaluateStatus(1).ok) {
            return;
        }

        intervalHandle = setInterval(() => {
            refresh();

            if (evaluateStatus(1).ok) {
                stopInterval();
            }
        }, tickMs);
    };

    // Kick off the ticker if we start already throttled — but only in the
    // browser: a component's init can run server-side (this package pairs
    // with `@lunora/nuxt`'s server rendering) with no `window`, and arming a
    // bare `setInterval` there would strand a live timer for the life of the
    // process (no `onDestroy` ever fires to call `teardown`). `consume()`'s
    // own call below stays unguarded — an explicit caller invoking `consume()`
    // is actively using the handle, and `reset()`/`teardown` remain reachable.
    if (isBrowser()) {
        startIntervalIfThrottled();
    }

    const consume = (count = 1): RateLimitStatus => {
        const result = evaluate(config, value, { consume: true, count, now: now(), reserve: false });

        // A rejected consume leaves `result.value` undefined — the bucket did
        // not move, but the projection still has to be republished.
        if (result.value !== undefined) {
            value = result.value;
        }

        refresh();
        startIntervalIfThrottled();

        return result.status;
    };

    const check = (count = 1): boolean => evaluateStatus(count).ok;

    const reset = (): void => {
        value = undefined;
        stopInterval();
        refresh();
    };

    return {
        check,
        consume,
        get disabled() {
            return !status.current.ok;
        },
        get ok() {
            return status.current.ok;
        },
        reset,
        get retryAfter() {
            return status.current.retryAfter;
        },
        teardown: stopInterval,
    };
};
