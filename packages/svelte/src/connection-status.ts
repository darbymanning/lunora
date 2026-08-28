import type { ConnectionStatus, LunoraClient } from "@lunora/client";

import { getLunoraClient } from "./context";
import type { ReactiveValue } from "./reactive";
import { source } from "./reactive";

/** The handle returned by {@link connectionStatus}: `current` is the latest aggregate live-socket status. */
export type ConnectionStatusHandle = ReactiveValue<ConnectionStatus>;

/**
 * Expose the client's aggregate live-socket status. Read `handle.current` and it
 * stays live: the value transitions through `idle` → `connecting` → `connected`
 * → `offline` as sockets open and drop — the Svelte equivalent of
 * `@lunora/react`'s `useConnectionStatus`. Use it to drive a connection indicator.
 *
 * The status listener attaches on the first tracked read of `current` and is
 * released once every effect that read it is destroyed, so a handle that's never
 * read attaches nothing.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published
 * by `setLunoraClient` (which must therefore be called during component init,
 * before this runs).
 */
export const connectionStatus = (client?: LunoraClient): ConnectionStatusHandle => {
    const resolved = client ?? getLunoraClient();

    // `connectionStatus()` is the client's own live accessor, so `current` reads
    // straight through it — nothing to mirror, nothing to go stale between the
    // handle being built and the first read.
    return source<ConnectionStatus>(
        () => resolved.connectionStatus(),
        (update) => resolved.onConnectionStatus(update),
    );
};
