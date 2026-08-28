import type { LunoraClient } from "@lunora/client";
import { LunoraError } from "@lunora/errors";
import { createContext, getAllContexts } from "svelte";

/**
 * The typed context pair for the per-app {@link LunoraClient}. `createContext`
 * owns the key, so there is none to collide with another library's entry, and
 * the getter is typed as `LunoraClient` rather than `unknown`.
 */
const [readClient, publishClient] = createContext<LunoraClient>();

/**
 * Publish a {@link LunoraClient} on the Svelte component context so that
 * descendant components can read it with {@link getLunoraClient} (or implicitly,
 * via the default-client lookups inside `query`/`mutation`/`hydratePreloaded`).
 *
 * Call this once, high in the tree (typically your root `+layout.svelte` or
 * `App.svelte`), during component initialisation — context must be set while the
 * component is being constructed, exactly like React's provider mounts once.
 * This is the Svelte analogue of mounting `LunoraProvider`.
 */
export const setLunoraClient = (client: LunoraClient): LunoraClient => publishClient(client);

/**
 * Read the {@link LunoraClient} published by {@link setLunoraClient} from the
 * nearest ancestor. Throws if no provider is mounted, mirroring `useLunora`'s
 * "must be used inside a LunoraProvider" guard so the failure is loud and
 * early rather than a confusing `undefined` deref later.
 *
 * Must be called during component initialisation (Svelte's context constraint);
 * the live handles returned by `query`/`hydratePreloaded` resolve the client
 * eagerly at call time for exactly this reason — the subscription they open is
 * lazy, but the client lookup is not.
 */
export const getLunoraClient = (): LunoraClient => {
    // Pre-flight so the `catch` below can only ever be the missing-provider case.
    // `createContext`'s getter throws for two different reasons — no ancestor set
    // the context, and "you are not in component init at all" — and blanket-
    // catching would relabel the second as the first, sending someone hunting for
    // a provider they already mounted. This throws Svelte's own accurate
    // `lifecycle_outside_component` for that case and is a map lookup otherwise.
    getAllContexts();

    try {
        return readClient();
    } catch {
        // Now unambiguous: the context exists, nothing published a client into it.
        throw new LunoraError("INTERNAL", "getLunoraClient(): no LunoraClient in context — call setLunoraClient(client) in an ancestor component first.");
    }
};
