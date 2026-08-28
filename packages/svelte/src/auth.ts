import type { User } from "@lunora/client";
import { getIdentityStore } from "@lunora/client/auth";

import { getLunoraClient } from "./context";
import { source } from "./reactive";

interface AuthHandle {
    /** Set the auth token on the underlying `LunoraClient`. */
    setToken: (token: string | null) => void;
    /** The auth token (`null` when signed out). */
    readonly token: string | null;
    /** The resolved user (`null` when signed out or still loading). */
    readonly user: User | null;
}

/**
 * Track the auth token and the resolved user identity. Both are lazy: the
 * listeners attach on the first tracked read and detach once every effect that
 * read them is destroyed. Calling `setToken(jwt)` after sign-in refreshes both.
 *
 * Read `token`/`user` off the handle rather than destructuring, or the value is
 * snapshotted and never updates.
 *
 * Pass an explicit client to bypass the ambient context (useful in tests).
 */
const auth = (explicitClient?: ReturnType<typeof getLunoraClient>): AuthHandle => {
    const client = explicitClient ?? getLunoraClient();
    const store = getIdentityStore(client);

    const token = source<string | null>(
        () => client.getAuthToken(),
        (update) => client.onAuthTokenChange(update),
    );

    const user = source<User | null>(
        () => store.getUser(),
        (update) => store.subscribe(update),
    );

    const setToken = (next: string | null): void => {
        client.setAuthToken(next);
    };

    return {
        setToken,
        get token() {
            return token.current;
        },
        get user() {
            return user.current;
        },
    };
};

/** Auth-gate booleans for template gating (`{#if gate.isAuthenticated}`), built on {@link auth}. */
interface AuthGateHandle {
    /** `true` once a token is set and the user has resolved. */
    readonly isAuthenticated: boolean;

    /** `true` while a token is set but the user hasn't resolved yet. */
    readonly isLoading: boolean;
}

/**
 * Auth-gate booleans built on {@link auth}. Svelte has no JSX-style
 * `Authenticated` slot component the way React/Vue/Solid do (this package is
 * plain `.ts` — no `.svelte` component compiler required), so this exposes the
 * same three-state logic as two booleans instead: a token with no resolved user
 * yet is `isLoading`; a token with a resolved user is `isAuthenticated`; no
 * token is neither (the signed-out state a template checks for with a plain
 * `{:else}`).
 *
 * ```ts
 * import { authGate } from "@lunora/svelte";
 * const gate = authGate();
 * // markup: {#if gate.isAuthenticated} signed in {:else if gate.isLoading} loading… {:else} signed out {/if}
 * ```
 *
 * Pass an explicit client to bypass the ambient context (useful in tests).
 */
const authGate = (explicitClient?: ReturnType<typeof getLunoraClient>): AuthGateHandle => {
    const handle = auth(explicitClient);

    return {
        get isAuthenticated() {
            return handle.token !== null && handle.user !== null;
        },
        get isLoading() {
            return handle.token !== null && handle.user === null;
        },
    };
};

export type { AuthGateHandle, AuthHandle };
export { auth, authGate };
