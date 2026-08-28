import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, Unsubscribe } from "@lunora/client";
import type { Page, PaginationResult, PaginationStatus } from "@lunora/client/pagination";
import { applyLoadMore, derivePaginationStatus, initialPages, rebalance } from "@lunora/client/pagination";
import { createSubscriber } from "svelte/reactivity";

import { stableWireKey } from "../../../shared/wire-key";
import { getLunoraClient } from "./context";
import { isFunctionReference } from "./is-function-reference";
import { box } from "./reactive";

/** The args a paginated query exposes minus the framework-supplied page cursor. */
type PaginatedArgs<F extends FunctionReference> = Omit<ArgsOf<F>, "paginationOpts">;

/** The element type of the `page` array a paginated query returns. */
type PageItemOf<F extends FunctionReference> = ReturnOf<F> extends { page: (infer T)[] } ? T : unknown;

interface PaginatedQueryOptions {
    /** Page size for the first page (and the default for `loadMore`). */
    initialNumItems: number;
    shardKey?: string;
}

interface PaginatedQueryHandle<T> {
    /** `true` while the first page or a `loadMore` page is in flight. */
    readonly isLoading: boolean;
    /** Request the next page. A no-op unless `status === "CanLoadMore"`. */
    loadMore: (numberItems: number) => void;
    /** Flattened items across every loaded page, in order. */
    readonly results: T[];
    readonly status: PaginationStatus;
}

interface InfiniteQueryOptions {
    /** Page size for the first page (and the default for `fetchNextPage`). */
    initialNumItems: number;
    shardKey?: string;
}

interface InfiniteQueryHandle<T> {
    /** Request the next page. A no-op unless `status === "CanLoadMore"`. */
    fetchNextPage: (numberItems?: number) => void;
    /** `true` when the loaded tail reports it can load another page. */
    readonly hasNextPage: boolean;
    /** `true` while a `fetchNextPage` page (beyond the first) is in flight. */
    readonly isFetchingNextPage: boolean;
    /** `true` while the first page is in flight. */
    readonly isLoading: boolean;
    /** One inner array per loaded page, in order; unresolved pages are omitted. */
    readonly pages: T[][];
    readonly status: PaginationStatus;
}

/** The engine's reactive surface, shared by `paginatedQuery` and `infiniteQuery`. */
interface PaginatedEngine<T> {
    loadMore: (numberItems: number) => void;
    readonly pageResults: (PaginationResult<T> | undefined)[];
    readonly status: PaginationStatus;
}

const buildPageArgs = (page: Page, baseArgs: Record<string, unknown>): Record<string, unknown> => {
    return {
        ...baseArgs,
        paginationOpts: { cursor: page.lower, endCursor: page.upper, numItems: page.numItems },
    };
};

// Key pages with the repo's canonical `stableWireKey` (keys sorted at every
// depth, wire-typed args tokenized) rather than raw `JSON.stringify`, so two
// structurally-equal arg records built with a different key order collapse to
// one key instead of opening a duplicate subscription — matching the client's
// own `SubscriptionRegistry.key`.
const buildPageKey = (functionPath: string, pageArgs: Record<string, unknown>): string => `${functionPath}::${stableWireKey(pageArgs)}`;

/**
 * Internal pagination engine. Manages page boundaries, subscriptions, results,
 * and split/join maintenance. Page subscriptions open on the first tracked read
 * of `pageResults`/`status` and tear down once every effect that read them is
 * destroyed — exactly the lifecycle `query.ts` gives a plain query.
 *
 * The `pendingPageKeys` set suppresses split/join rebalance while a freshly
 * loaded page is still awaiting its first result — matching Vue's policy so a
 * shrinking tail edit before `loadMore` resolves cannot silently undo the
 * loadMore via the JOIN branch.
 */
const createPaginatedEngine = <T>(
    client: LunoraClient,
    function_: FunctionReference,
    baseArgs: "skip" | Record<string, unknown>,
    options: { initialNumItems: number; shardKey?: string },
): PaginatedEngine<T> => {
    const { initialNumItems, shardKey } = options;
    const skipped = baseArgs === "skip";

    let pages: Page[] = initialPages(initialNumItems);
    const pageResults = box<(PaginationResult<T> | undefined)[]>([]);

    const resultsByKey = new Map<string, PaginationResult<T>>();
    const activeSubs = new Map<string, Unsubscribe>();

    /**
     * Keys of pages that are still awaiting their first server result after a
     * `loadMore`. Rebalance is suppressed while this set is non-empty to prevent
     * the JOIN branch from merging a freshly appended page away before it resolves.
     */
    const pendingPageKeys = new Set<string>();

    const rebuildPageResults = (): void => {
        if (baseArgs === "skip") {
            pageResults.set([]);

            return;
        }

        pageResults.set(pages.map((page) => resultsByKey.get(buildPageKey(function_["__lunoraRef"], buildPageArgs(page, baseArgs)))));
    };

    /**
     * When `rebalance` splits or joins pages the per-page result keys change.
     * Carry the existing results to the new keys so visible data is preserved
     * while the server acknowledges the new boundary (a joined page seeds from
     * the lower of the merged pages; a split page seeds both halves from the
     * parent). Best-effort — the fresh subscription overwrites it once attached.
     *
     * Must run BEFORE `pages` is swapped / `syncSubscriptions()` so the new keys
     * are seeded before the stale-subscription sweep prunes the old ones. Without
     * this, `rebuildPageResults` emits `undefined` for the re-keyed page(s) and
     * `results`/`pages` drop those items until the new subscription's first frame
     * arrives.
     */
    const migrateResultsForRebalance = (oldPages: Page[], newPages: Page[]): void => {
        if (baseArgs === "skip") {
            return;
        }

        const keyOf = (page: Page): string => buildPageKey(function_["__lunoraRef"], buildPageArgs(page, baseArgs));

        for (const newPage of newPages) {
            const newKey = keyOf(newPage);

            if (resultsByKey.has(newKey)) {
                continue;
            }

            // The old page whose lower bound matches covers the start of this range.
            const donor = oldPages.find((op) => op.lower === newPage.lower);

            if (donor) {
                const carried = resultsByKey.get(keyOf(donor));

                if (carried) {
                    resultsByKey.set(newKey, carried);
                }
            }
        }
    };

    const syncPass = (): void => {
        if (baseArgs === "skip") {
            for (const unsub of activeSubs.values()) {
                unsub();
            }

            activeSubs.clear();
            pageResults.set([]);

            return;
        }

        const wantedKeys = new Set<string>();

        for (const page of pages) {
            wantedKeys.add(buildPageKey(function_["__lunoraRef"], buildPageArgs(page, baseArgs)));
        }

        // Close stale subscriptions and drop their cached results so a later
        // re-key that reproduces a superseded key cannot resurrect stale data,
        // and the result map does not grow unboundedly across loadMore cycles.
        for (const [key, unsub] of activeSubs) {
            if (!wantedKeys.has(key)) {
                unsub();
                activeSubs.delete(key);
                pendingPageKeys.delete(key);
                resultsByKey.delete(key);
            }
        }

        // Open new subscriptions.
        for (const page of pages) {
            const pageArgs = buildPageArgs(page, baseArgs);
            const key = buildPageKey(function_["__lunoraRef"], pageArgs);

            if (activeSubs.has(key)) {
                continue;
            }

            // Mark this page as pending until its first result arrives.
            pendingPageKeys.add(key);

            const unsub = client.subscribe(
                function_,
                pageArgs,
                (value) => {
                    resultsByKey.set(key, value as PaginationResult<T>);

                    // This page has resolved; remove from the pending set.
                    pendingPageKeys.delete(key);

                    rebuildPageResults();

                    // SPLIT/JOIN maintenance: only rebalance when no pages are still
                    // in their initial-load phase. A newly appended page (from
                    // `loadMore`) stays in `pendingPageKeys` until its first result
                    // arrives; joining before that would discard visible content.
                    if (pendingPageKeys.size === 0) {
                        const next = rebalance(pages, pageResults.current);

                        if (next) {
                            // Carry results to the re-keyed pages before swapping the
                            // page list so the sweep in `syncSubscriptions` cannot drop
                            // visible items before the new subscription's first frame.
                            migrateResultsForRebalance(pages, next);
                            pages = next;
                            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- runs inside a deferred subscription callback, after syncSubscriptions is defined
                            syncSubscriptions();
                            rebuildPageResults();
                        }
                    }
                },
                { shardKey },
            );

            activeSubs.set(key, unsub);
        }
    };

    // `client.subscribe` replays a cached value to the new subscriber
    // SYNCHRONOUSLY — the callback fires before `subscribe` returns, i.e. before
    // this page's `activeSubs.set(key, unsub)` above is recorded. If that replay
    // empties `pendingPageKeys` and `rebalance` returns a new layout, the callback
    // re-enters `syncSubscriptions` against half-populated bookkeeping. Re-entering
    // the open loop there would duplicate still-wanted subs and orphan handles (the
    // outer frame's `activeSubs.set` overwrites the reentrant entry) — a leaked,
    // unsubscribable WS subscription. So guard: while a pass is running, a nested
    // call only flags a re-sync, which the drain below runs once the outer pass has
    // finished recording every handle — that follow-up pass closes any now-stale
    // sub and opens the genuinely new pages against complete bookkeeping.
    let syncing = false;
    let resyncRequested = false;

    const syncSubscriptions = (): void => {
        if (syncing) {
            resyncRequested = true;

            return;
        }

        syncing = true;

        try {
            do {
                resyncRequested = false;
                syncPass();
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- resyncRequested is set by syncPass through a nested call the flow analyzer cannot track
            } while (resyncRequested);
        } finally {
            syncing = false;
        }
    };

    // The page subscriptions open on the first tracked read and close once every
    // effect that read them is destroyed — matching `query.ts`, so no WS handles
    // leak after unmount and a server render opens nothing.
    const track = createSubscriber(() => {
        syncSubscriptions();
        rebuildPageResults();

        return () => {
            for (const unsub of activeSubs.values()) {
                unsub();
            }

            activeSubs.clear();
            resultsByKey.clear();
            pendingPageKeys.clear();
            pages = initialPages(initialNumItems);
            pageResults.set([]);
        };
    });

    const loadMore = (numberItems: number): void => {
        if (baseArgs === "skip") {
            return;
        }

        const { nextCursor, status: currentStatus } = derivePaginationStatus(false, pageResults.current);

        if (currentStatus !== "CanLoadMore") {
            return;
        }

        const next = applyLoadMore(pages, nextCursor, numberItems);

        if (!next) {
            return;
        }

        // `applyLoadMore` pins the open-ended tail: its args key changes from
        // `endCursor: null` to `endCursor: cursor`. Carry the existing result to
        // the new key before updating pages so `rebuildPageResults` does not lose
        // the first-page data when the pinned subscription re-opens.
        const oldTail = pages.at(-1);
        const newPinnedPage = next.at(-2); // applyLoadMore appends the new open tail last

        if (oldTail && newPinnedPage) {
            const oldKey = buildPageKey(function_["__lunoraRef"], buildPageArgs(oldTail, baseArgs));
            const newKey = buildPageKey(function_["__lunoraRef"], buildPageArgs(newPinnedPage, baseArgs));

            if (oldKey !== newKey) {
                const carried = resultsByKey.get(oldKey);

                if (carried) {
                    resultsByKey.set(newKey, carried);
                    // Drop the superseded open-tail entry so a later JOIN that
                    // reproduces this key cannot serve the pre-loadMore result.
                    resultsByKey.delete(oldKey);
                }
            }
        }

        pages = next;
        syncSubscriptions();
        rebuildPageResults();
    };

    return {
        loadMore,
        get pageResults() {
            track();

            return pageResults.current;
        },
        get status() {
            track();

            return derivePaginationStatus(skipped, pageResults.current).status;
        },
    };
};

/**
 * Open a live paginated query. The first page opens on the first tracked read;
 * call `loadMore(n)` to append the next. Results are flattened across all loaded
 * pages. Read `results`/`status`/`isLoading` off the handle rather than
 * destructuring, or the value is snapshotted and never updates.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client from the
 * Svelte context.
 *
 * For args that change, build the handle inside a `$derived.by`, as `query`
 * documents. Each change builds a fresh handle, so pagination resets to the
 * first page.
 */
export function paginatedQuery<F extends FunctionReference>(
    function_: F,
    args: "skip" | PaginatedArgs<F>,
    options: PaginatedQueryOptions,
): PaginatedQueryHandle<PageItemOf<F>>;
export function paginatedQuery<F extends FunctionReference>(
    client: LunoraClient,
    function_: F,
    args: "skip" | PaginatedArgs<F>,
    options: PaginatedQueryOptions,
): PaginatedQueryHandle<PageItemOf<F>>;
export function paginatedQuery<F extends FunctionReference>(
    clientOrFunction: F | LunoraClient,
    functionOrArguments: F | "skip" | PaginatedArgs<F>,
    argumentsOrOptions: PaginatedQueryOptions | "skip" | PaginatedArgs<F>,
    maybeOptions?: PaginatedQueryOptions,
): PaginatedQueryHandle<PageItemOf<F>> {
    const hasExplicitClient = !isFunctionReference(clientOrFunction);
    const client = hasExplicitClient ? clientOrFunction : getLunoraClient();
    const functionRef = (hasExplicitClient ? functionOrArguments : clientOrFunction) as F;
    const args = (hasExplicitClient ? argumentsOrOptions : functionOrArguments) as "skip" | PaginatedArgs<F>;
    const options = (hasExplicitClient ? maybeOptions : argumentsOrOptions) as PaginatedQueryOptions;

    const engine = createPaginatedEngine<PageItemOf<F>>(client, functionRef, args, options);

    return {
        get isLoading() {
            const current = engine.status;

            return current === "LoadingFirstPage" || current === "LoadingMore";
        },
        loadMore: engine.loadMore,
        get results() {
            return engine.pageResults.flatMap((page) => page?.page ?? []);
        },
        get status() {
            return engine.status;
        },
    };
}

/**
 * Open a live paginated query keeping each page as its own inner array
 * (TanStack-Query-style `fetchNextPage` / `hasNextPage` shape).
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client from the
 * Svelte context.
 */
export function infiniteQuery<F extends FunctionReference>(
    function_: F,
    args: "skip" | PaginatedArgs<F>,
    options: InfiniteQueryOptions,
): InfiniteQueryHandle<PageItemOf<F>>;
export function infiniteQuery<F extends FunctionReference>(
    client: LunoraClient,
    function_: F,
    args: "skip" | PaginatedArgs<F>,
    options: InfiniteQueryOptions,
): InfiniteQueryHandle<PageItemOf<F>>;
export function infiniteQuery<F extends FunctionReference>(
    clientOrFunction: F | LunoraClient,
    functionOrArguments: F | "skip" | PaginatedArgs<F>,
    argumentsOrOptions: InfiniteQueryOptions | "skip" | PaginatedArgs<F>,
    maybeOptions?: InfiniteQueryOptions,
): InfiniteQueryHandle<PageItemOf<F>> {
    const hasExplicitClient = !isFunctionReference(clientOrFunction);
    const client = hasExplicitClient ? clientOrFunction : getLunoraClient();
    const functionRef = (hasExplicitClient ? functionOrArguments : clientOrFunction) as F;
    const args = (hasExplicitClient ? argumentsOrOptions : functionOrArguments) as "skip" | PaginatedArgs<F>;
    const options = (hasExplicitClient ? maybeOptions : argumentsOrOptions) as InfiniteQueryOptions;
    const { initialNumItems } = options;

    const engine = createPaginatedEngine<PageItemOf<F>>(client, functionRef, args, options);

    return {
        fetchNextPage: (numberItems?: number) => {
            engine.loadMore(numberItems ?? initialNumItems);
        },
        get hasNextPage() {
            return engine.status === "CanLoadMore";
        },
        get isFetchingNextPage() {
            return engine.status === "LoadingMore";
        },
        get isLoading() {
            return engine.status === "LoadingFirstPage";
        },
        get pages() {
            return engine.pageResults.flatMap((page) => (page ? [page.page] : []));
        },
        get status() {
            return engine.status;
        },
    };
}

export type { InfiniteQueryHandle, InfiniteQueryOptions, PageItemOf, PaginatedArgs, PaginatedQueryHandle, PaginatedQueryOptions };
