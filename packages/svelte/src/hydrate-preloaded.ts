import type { FunctionReference, LunoraClient, Preloaded } from "@lunora/client";

import { getLunoraClient } from "./context";
import type { ReactiveValue } from "./reactive";
import { source } from "./reactive";

/**
 * Hydrate a query handle from a {@link Preloaded} token produced by
 * `preloadQuery` during SSR, then keep it live — the reactive-loader handoff.
 *
 * `current` is seeded **synchronously** with `preloaded.value`, so the very
 * first read during hydration returns the server value with no loading flash
 * and no hydration mismatch — there is no `undefined` window and no refetch. On
 * the first tracked read in the browser a live WS subscription attaches and
 * every subsequent delta re-runs the readers, exactly like a plain `query`
 * handle. This is the Svelte equivalent of React's `usePreloadedQuery`.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published
 * by `setLunoraClient`.
 *
 * Note on SSR: nothing tracks during `renderToString`, so the subscription is
 * never opened server-side and `current` simply reports the seeded value. The
 * token's `value` is the single source of truth for the first paint either way.
 */
// eslint-disable-next-line import/prefer-default-export -- the package barrel re-exports every handle by name; a default here would break the `import { hydratePreloaded } from "@lunora/svelte"` surface.
export const hydratePreloaded = <T>(preloaded: Preloaded<T>, client?: LunoraClient): ReactiveValue<T> => {
    const resolvedClient = client ?? getLunoraClient();
    const { args, functionPath, shardKey, value } = preloaded;
    const functionRef: FunctionReference = { __lunoraRef: functionPath };

    // Seeded with the token's value, so an untracked read — the server render —
    // reports the server's answer without opening anything.
    let latest = value;

    return source<T>(
        () => latest,
        (update) =>
            resolvedClient.subscribe(
                functionRef,
                args,
                (next: unknown) => {
                    latest = next as T;
                    update();
                },
                { shardKey },
            ),
    );
};
