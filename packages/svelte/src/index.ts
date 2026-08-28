export type { ActionHandle } from "./action";
export { action } from "./action";
export type { AgentApi, AgentHandle, AgentOptions, AgentThreadRecord, AgentThreadStatus } from "./agent";
export { agent } from "./agent";
export type { AgentChatApi, AgentChatHandle, AgentChatMessage, AgentChatOptions, AgentLiveEvent, AgentProgressEvent, AgentTokenDelta } from "./agent-chat";
export { agentChat } from "./agent-chat";
export type { AgentStateApi, AgentStateHandle, AgentStateOptions } from "./agent-state";
export { agentState } from "./agent-state";
export type { AgentToolEvent, AgentToolEventsApi, AgentToolEventsHandle, AgentToolEventsOptions } from "./agent-tool-events";
export { agentToolEvents } from "./agent-tool-events";
export type { AuthGateHandle, AuthHandle } from "./auth";
export { auth, authGate } from "./auth";
export type { ConnectionStatusHandle } from "./connection-status";
export { connectionStatus } from "./connection-status";

/**
 * Svelte adapter for Lunora (`@lunora/svelte`).
 *
 * Thin, idiomatic glue over the framework-neutral `@lunora/client` (no React):
 * runes-native live handles you read as plain properties, an optimistic
 * mutation helper, and the reactive-loader handoff (`hydratePreloaded`). The
 * contract mirrors `@lunora/react`: `setLunoraClient` / `getLunoraClient` are
 * the context provider/consumer; `query` is a live handle whose `current` is
 * the server value (React's `useQuery`); `mutation` is an optimistic
 * `{ data, error, pending, mutate, reset }` (React's `useMutation`); and
 * `hydratePreloaded` is the SSR-seed-to-live handoff (React's
 * `usePreloadedQuery`).
 *
 * Reactivity is `svelte/reactivity`'s `createSubscriber`, so every handle is
 * tracked by `$derived` / `$effect` / a template read, subscribes on the first
 * such read, and releases when the last reader goes away — with the package
 * still plain `.ts`: no `.svelte`/`.svelte.ts` compiler step to build or test it.
 *
 * Read reactive members OFF the handle (`send.pending`, `messages.current`).
 * Destructuring them copies the value once and it never updates.
 *
 * Server-side preload helpers (`createServerClient`, `preloadQuery`) live in the
 * socket-free `@lunora/svelte/server` entry (a re-export of `@lunora/client/ssr`, the
 * framework-neutral server contract) — import them there in your SvelteKit
 * `+page.ts` / `+layout.ts` load.
 */
export { getLunoraClient, setLunoraClient } from "./context";
export type { FlagContext, FlagValue } from "./flag";
export { flag, flags } from "./flag";
export { hydratePreloaded } from "./hydrate-preloaded";
export type { MutationHandle } from "./mutation";
export { mutation } from "./mutation";
export type { MutatorHandle, MutatorState, MutatorTransaction } from "./mutator";
export { mutator } from "./mutator";
export type { InfiniteQueryHandle, InfiniteQueryOptions, PageItemOf, PaginatedArgs, PaginatedQueryHandle, PaginatedQueryOptions } from "./paginated-query";
export { infiniteQuery, paginatedQuery } from "./paginated-query";
export type { HeartbeatReference, ListPresentReference, PresenceHandle, PresenceOptions } from "./presence";
export { presence } from "./presence";
export type { QueryHandle, QueryOptions } from "./query";
export { query } from "./query";
export type { RateLimitHandle, RateLimitOptions } from "./rate-limit";
export { rateLimit } from "./rate-limit";
export type { StreamHandle, StreamOptions, StreamStatus } from "./stream";
export { stream } from "./stream";
export type { SubscriptionHandle, SubscriptionOptions } from "./subscription";
export { subscription } from "./subscription";
export type { VoiceAgentHandle, VoiceAgentOptions, VoiceAudioFormat, VoiceReference, VoiceStatus } from "./voice-agent";
export { voiceAgent } from "./voice-agent";
// Re-export the core types adapters lean on, so consumers import them from one place.
export type { ArgsOf, ConnectionStatus, FunctionReference, LunoraClient, MutationCallOptions, Preloaded, ReturnOf } from "@lunora/client";
