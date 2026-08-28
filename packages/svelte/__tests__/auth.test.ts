import type { LunoraClient, Unsubscribe, User } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import { auth, authGate } from "../src/auth";
import { track } from "./track";

const createAuthFakeClient = () => {
    let token: string | null = null;

    let currentUser: User | null = null;
    const tokenListeners = new Set<(t: string | null) => void>();

    const setAuthToken = vi.fn<(next: string | null) => void>((next) => {
        token = next;
        for (const listener of tokenListeners) listener(next);
    });

    const getAuthToken = vi.fn<() => string | null>(() => token);

    const onAuthTokenChange = vi.fn<(listener: (tokenValue: string | null) => void) => Unsubscribe>((listener) => {
        tokenListeners.add(listener);

        return () => {
            tokenListeners.delete(listener);
        };
    });

    const getCurrentUser = vi.fn<() => Promise<User | null>>(async () => currentUser);

    const setCurrentUser = (user: User | null) => {
        currentUser = user;
    };

    const client = {
        getAuthToken,
        getCurrentUser,
        onAuthTokenChange,
        setAuthToken,
    } as unknown as LunoraClient;

    return { client, getAuthToken, getCurrentUser, onAuthTokenChange, setAuthToken, setCurrentUser };
};

const flushAsync = async (): Promise<void> => {
    await vi.waitFor(() => undefined);
};

describe(auth, () => {
    it("token starts as null when no token is set", () => {
        const fake = createAuthFakeClient();
        const handle = auth(fake.client);

        const reader = track(() => handle.token);

        expect(handle.token).toBeNull();

        reader.stop();
    });

    it("setToken updates the token", () => {
        const fake = createAuthFakeClient();
        const handle = auth(fake.client);

        const reader = track(() => handle.token);

        handle.setToken("jwt-abc");

        expect(fake.setAuthToken).toHaveBeenCalledWith("jwt-abc");
        expect(handle.token).toBe("jwt-abc");

        reader.stop();
    });

    it("user resolves after token is set", async () => {
        const fake = createAuthFakeClient();
        fake.setCurrentUser({ id: "u_1" });

        const handle = auth(fake.client);

        const reader = track(() => handle.user);

        expect(handle.user).toBeNull();

        handle.setToken("jwt-abc");
        await flushAsync();

        expect(handle.user).toStrictEqual({ id: "u_1" });

        reader.stop();
    });

    it("user clears on sign-out", async () => {
        const fake = createAuthFakeClient();
        fake.setCurrentUser({ id: "u_1" });

        const handle = auth(fake.client);
        const reader = track(() => handle.user);

        handle.setToken("jwt-abc");
        await flushAsync();

        expect(handle.user).toStrictEqual({ id: "u_1" });

        handle.setToken(null);
        await flushAsync();

        expect(handle.user).toBeNull();

        reader.stop();
    });
});

describe(authGate, () => {
    it("is neither loading nor authenticated before a token is set (signed out)", () => {
        const fake = createAuthFakeClient();
        const gate = authGate(fake.client);

        const authenticated = track(() => gate.isAuthenticated);
        const loading = track(() => gate.isLoading);

        expect(gate.isAuthenticated).toBe(false);
        expect(gate.isLoading).toBe(false);

        authenticated.stop();
        loading.stop();
    });

    it("is loading once a token is set but the user hasn't resolved yet", () => {
        const fake = createAuthFakeClient();
        const gate = authGate(fake.client);

        const authenticated = track(() => gate.isAuthenticated);
        const loading = track(() => gate.isLoading);

        fake.setAuthToken("jwt-abc");

        expect(gate.isLoading).toBe(true);
        expect(gate.isAuthenticated).toBe(false);

        authenticated.stop();
        loading.stop();
    });

    it("is authenticated once the token is set and the user has resolved", async () => {
        const fake = createAuthFakeClient();
        fake.setCurrentUser({ id: "u_1" });

        const gate = authGate(fake.client);

        const authenticated = track(() => gate.isAuthenticated);
        const loading = track(() => gate.isLoading);

        fake.setAuthToken("jwt-abc");
        await flushAsync();

        expect(gate.isAuthenticated).toBe(true);
        expect(gate.isLoading).toBe(false);

        authenticated.stop();
        loading.stop();
    });

    it("returns to signed out on sign-out", async () => {
        const fake = createAuthFakeClient();
        fake.setCurrentUser({ id: "u_1" });

        const gate = authGate(fake.client);

        const authenticated = track(() => gate.isAuthenticated);
        const loading = track(() => gate.isLoading);

        fake.setAuthToken("jwt-abc");
        await flushAsync();

        expect(gate.isAuthenticated).toBe(true);

        fake.setAuthToken(null);
        await flushAsync();

        expect(gate.isAuthenticated).toBe(false);
        expect(gate.isLoading).toBe(false);

        authenticated.stop();
        loading.stop();
    });
});
