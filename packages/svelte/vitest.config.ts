import { getVitestConfig } from "../../tools/get-vitest-config";

// ratchet: below the default floor; raise as coverage improves.
export default getVitestConfig(
    {
        // Without the browser condition, `svelte` resolves to its SSR build, where
        // `createSubscriber` is inert and every primitive would look dead — the
        // same guard `packages/auth-ui`'s svelte project needs to mount at all.
        resolve: { conditions: ["browser"] },
        ssr: { resolve: { conditions: ["browser"] } },
        test: { environment: "node" },
    },
    { branches: 55, lines: 75, statements: 75 },
);
