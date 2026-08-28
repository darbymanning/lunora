import { describe, expect, it } from "vitest";

import { getLunoraClient } from "../src/context";

/** Svelte's own "not during component init" error, whichever build emitted it. */
const OUTSIDE_COMPONENT = /lifecycle_outside_component|outside component/i;

/** The adapter's missing-provider message, which must NOT stand in for the above. */
const MISSING_PROVIDER = /setLunoraClient/;

describe(getLunoraClient, () => {
    it("reports Svelte's own lifecycle error, not a missing provider, when called outside component init", () => {
        // `createContext`'s getter throws for two different reasons, and the
        // missing-provider message must not swallow this one — it would send a
        // caller hunting for a provider they already mounted when the real fault
        // is calling `query`/`mutation` from an event handler or module scope.
        expect(() => getLunoraClient()).toThrow(OUTSIDE_COMPONENT);
        expect(() => getLunoraClient()).not.toThrow(MISSING_PROVIDER);
    });
});
