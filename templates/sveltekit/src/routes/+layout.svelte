<script lang="ts">
    import type { Snippet } from "svelte";

    import { LunoraClient } from "lunorash/client";
    import { setLunoraClient } from "@lunora/svelte";

    let { children }: { children: Snippet } = $props();

    // Publish one LunoraClient on Svelte context for the whole app. The live
    // `query`/`mutation`/`hydratePreloaded` handles resolve it via getContext.
    // `setContext` must run during component init — exactly here, at the root.
    //
    // SAME-ORIGIN: Lunora realtime is mounted under `/_lunora/*` in SvelteKit's
    // own worker (see `src/worker.ts`'s `.buildFrameworkWorker(...)`), so the
    // client talks to the page origin — no second worker, no CORS, and the
    // WebSocket resumes the same cookie-based session. `VITE_LUNORA_URL`
    // overrides only for a split deploy.
    const url = import.meta.env.VITE_LUNORA_URL ?? (typeof window === "undefined" ? "" : window.location.origin);

    setLunoraClient(new LunoraClient({ url }));
</script>

{@render children()}
