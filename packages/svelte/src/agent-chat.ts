import type { FunctionReference, LunoraClient, OptimisticMessage } from "@lunora/client";
import { maxSeq, reconcileOptimistic } from "@lunora/client";

import { isBrowser } from "../../../shared/is-browser";
import type { AgentThreadRecord, AgentThreadStatus } from "./agent";
import { isClient, NO_MUTATION_REF } from "./agent";
import { getLunoraClient } from "./context";
import { mutation } from "./mutation";
import { box } from "./reactive";

/**
 * One persisted (or optimistic) thread message, as `agents:agentMessages`
 * surfaces it. Client-safe mirror of `@lunora/agent`'s `AgentMessageRow` —
 * re-declared here (rather than imported) so this Svelte entry never pulls in the
 * server-only `@lunora/agent` module graph. Keep in sync with the
 * `agent_messages` table in `packages/agent/src/component.ts`.
 */
interface AgentChatMessage {
    content: string;
    createdAt?: number;

    /**
     * `true` for a client-side optimistic user message not yet acknowledged by
     * the server. Cleared once the durable history carries the matching user turn.
     */
    optimistic?: boolean;
    role: "assistant" | "system" | "tool" | "user";
    seq: number;
    /** Approval lifecycle marker on a human-in-the-loop tool message. */
    status?: "approved" | "awaiting_approval" | "rejected";
    toolCallId?: string;
    toolCalls?: ReadonlyArray<{ id: string; input: unknown; name: string }>;
    toolName?: string;
}

/**
 * A live token delta streamed while a turn is generating. Client-safe mirror of
 * `@lunora/agent`'s `AgentTokenDelta`. Ephemeral — deltas feed
 * {@link AgentChatHandle.streamingText} live and are never replayed; the
 * persisted assistant message stays the single source of truth.
 */
interface AgentTokenDelta {
    /** Discriminates the token arm of {@link AgentLiveEvent}; unset on the wire (token is the default). */
    kind?: "token";
    /** The incremental text chunk the model just produced. */
    text: string;
    /** The thread this delta belongs to. */
    threadKey: string;
    /** The zero-based index of the turn producing the delta. */
    turn: number;
}

/**
 * A live tool-progress event streamed via `ctx.reportProgress(...)`. Client-safe
 * mirror of `@lunora/agent`'s `AgentProgressEvent`. Ephemeral and `toolCallId`-keyed;
 * surfaced by `agentToolEvents`, ignored by {@link AgentChatHandle.streamingText}.
 */
interface AgentProgressEvent {
    /** The arbitrary, JSON-serializable payload the tool reported. */
    data: unknown;
    /** Discriminates the progress arm of {@link AgentLiveEvent}. */
    kind: "progress";
    /** The thread this event belongs to. */
    threadKey: string;
    /** The tool call this progress belongs to. */
    toolCallId: string;
}

/**
 * A single event on the agent's live-only channel — a streamed token delta or a
 * tool progress event. Client-safe mirror of `@lunora/agent`'s `AgentLiveEvent`.
 * Discriminate on `kind` (`"progress"` for the progress arm; token deltas leave
 * it unset).
 */
type AgentLiveEvent = AgentProgressEvent | AgentTokenDelta;

/** The `agents:agentMessages` reference — live durable thread history. */
type AgentMessagesReference = FunctionReference<"query", { key: string; limit?: number }, ReadonlyArray<Record<string, unknown>>>;

/** The `agents:agentResolveApproval` reference — resolves a human-in-the-loop tool approval. */
type AgentApprovalReference = FunctionReference<
    "mutation",
    { decision: "approve" | "reject"; instanceId: string; note?: string; threadKey: string; toolCallId: string },
    { resolved: boolean }
>;

/** The `agents:agentThread` reference — live thread status + in-flight `instanceId`. */
type AgentThreadReference = FunctionReference<"query", { key: string }, Record<string, unknown> | undefined>;

/**
 * An app stream reference that tees the agent's in-flight live events, keyed by
 * thread. Carries token deltas and — since `ctx.reportProgress` rides the same
 * sink — tool progress events; this handle consumes only the token arm.
 */
type AgentTokenStreamReference = FunctionReference<"stream", { key: string }, AgentLiveEvent>;

/**
 * The `agents.*` reference surface the chat handle reads. A structural subset of
 * the generated `api.agents`, so the whole generated `api` object is assignable.
 */
interface AgentChatApi {
    agents: {
        agentMessages: AgentMessagesReference;
        agentResolveApproval: AgentApprovalReference;
        agentThread: AgentThreadReference;
    };
}

interface AgentChatOptions {
    /** The generated `api` — its `agents.*` surface provides history, thread state, and approval resolution. */
    api: AgentChatApi;

    /**
     * Optional app mutation over the agent's cancel path
     * (`ctx.agents[name].cancel(id)`). Called with `{ instanceId, threadKey }`.
     * When omitted (or no run is in flight) {@link AgentChatHandle.cancel} is a
     * no-op.
     */
    cancel?: FunctionReference<"mutation">;
    /** History depth forwarded to `agents:agentMessages`. */
    limit?: number;

    /**
     * The app mutation that starts (or continues) a run — a thin wrapper over
     * `ctx.agents[name].run(...)`. Called with `{ threadKey, input }` merged with
     * {@link AgentChatOptions.sendArgs} and the per-call args.
     */
    send: FunctionReference<"mutation">;
    /** Extra args merged into every `send` call (e.g. an `owner` or `title`). */
    sendArgs?: Record<string, unknown>;

    /**
     * Optional live token-delta stream — an app stream function that tees the
     * agent's in-flight deltas. When omitted {@link AgentChatHandle.streamingText}
     * stays empty and the UI updates message-by-message from durable history.
     */
    stream?: AgentTokenStreamReference;
    /** The thread to observe and continue. */
    threadKey: string;
}

interface AgentChatHandle {
    /** Approve a paused human-in-the-loop tool call (optionally with a note). */
    approve: (toolCallId: string, note?: string) => Promise<void>;

    /**
     * Terminate the in-flight run and mark its thread `"cancelled"`. Resolves as a
     * no-op when no `cancel` mutation was supplied or no run is in flight.
     */
    cancel: () => Promise<void>;
    /** Durable thread history (oldest first) plus any un-acknowledged optimistic user turns. */
    readonly messages: ReadonlyArray<AgentChatMessage>;
    /** Reject a paused human-in-the-loop tool call (optionally with a reason). */
    reject: (toolCallId: string, note?: string) => Promise<void>;
    /** Start (or continue) a run with a user message; extra args merge over `sendArgs`. Appends an optimistic user turn. */
    send: (input: string, args?: Record<string, unknown>) => Promise<void>;
    /** The live thread status, or `undefined` before the thread exists. */
    readonly status: AgentThreadStatus | undefined;

    /**
     * The in-flight turn's streamed text — live-only, `""` once the turn persists
     * to `messages`. Populated when a `stream` reference is supplied (via the
     * `client.stream(...)`); with no reference it stays `""` and the UI advances
     * message-by-message from durable history.
     */
    readonly streamingText: string;

    /**
     * Stop the live history + thread subscriptions (and the token stream, if any).
     * Call in `onDestroy` (`onDestroy(handle.teardown)`).
     */
    teardown: () => void;
}

const createAgentChatHandle = (client: LunoraClient, options: AgentChatOptions): AgentChatHandle => {
    const { api, cancel: cancelReference, limit, send: sendReference, sendArgs, stream: streamReference, threadKey } = options;

    const sendMutation = mutation(client, sendReference);
    const cancelMutation = mutation(client, cancelReference ?? NO_MUTATION_REF);
    const approvalMutation = mutation(client, api.agents.agentResolveApproval);

    // Latest server state kept in closures so the action closures read it
    // synchronously; the boxes below drive reactive reads.
    let latestThread: AgentThreadRecord | undefined;
    let durable: ReadonlyArray<AgentChatMessage> = [];
    let optimistic: ReadonlyArray<OptimisticMessage> = [];
    // The live token/progress events from the current stream, kept in a closure so
    // `recomputeStreamingText` reads them synchronously alongside `durable`.
    let liveEvents: ReadonlyArray<AgentLiveEvent> = [];
    // A monotonic id source for optimistic rows — handle-instance local.
    let nextId = 0;

    const messagesBox = box<ReadonlyArray<AgentChatMessage>>([]);
    const statusBox = box<AgentThreadStatus | undefined>(undefined);
    const streamingTextBox = box("");

    // Merge durable history with the optimistic user turns the server hasn't
    // acknowledged yet, and publish it.
    const recompute = (): void => {
        const visible = reconcileOptimistic(optimistic, durable);

        if (visible.length === 0) {
            messagesBox.set(durable);

            return;
        }

        // Base synthetic seqs above the highest real durable seq (not just
        // `durable.length`, which can under-count when durable rows have gaps) so
        // an optimistic row's placeholder seq never collides with a real one.
        const maxDurableSeq = maxSeq(durable);

        messagesBox.set([
            ...durable,
            ...visible.map<AgentChatMessage>((pending, index) => {
                return {
                    content: pending.content,
                    optimistic: true,
                    role: "user",
                    seq: maxDurableSeq + 1 + index,
                };
            }),
        ]);
    };

    // The in-flight turn is the one whose assistant message hasn't persisted yet:
    // each completed turn persists exactly one assistant row, so `turn >= <count of
    // durable assistant rows>` isolates deltas that have NOT been superseded. Once
    // the turn's message lands the count advances and its deltas fall away — the
    // persisted message becomes the source of truth. Token deltas only — progress
    // events (`kind === "progress"`) ride the same stream but carry no turn text;
    // `agentToolEvents` surfaces those. Recomputed on every stream chunk AND every
    // history change (the assistant count is the retire gate).
    const recomputeStreamingText = (): void => {
        const assistantCount = durable.filter((message) => message.role === "assistant").length;
        const text = liveEvents
            .filter((event): event is AgentTokenDelta => event.kind !== "progress" && event.threadKey === threadKey && event.turn >= assistantCount)
            .map((delta) => delta.text)
            .join("");

        streamingTextBox.set(text);
    };

    // The subscriptions below are client-only side effects: a component's init
    // can run server-side (this package pairs with `@lunora/nuxt`'s server
    // rendering) with no `window`, and opening a live WS subscription there
    // would fire during `renderToString` with no corresponding `onDestroy` to
    // close it — every server render would leak a subscription (SVELTE-01,
    // mirrors the `presence.ts` guard). Skip them server-side; `messages`/
    // `status`/`streamingText` stay at their inert initial values until the
    // component hydrates and `teardown` becomes a no-op.

    // The token stream is optional and, unlike the lazy `stream` primitive, is
    // consumed eagerly here so it opens with the handle and closes on `teardown`
    // — matching the history/thread subscriptions. With no reference nothing is
    // opened and `streamingText` stays `""`.
    const openTokenStream = (): (() => void) => {
        if (streamReference === undefined || !isBrowser()) {
            return () => undefined;
        }

        const iterable = client.stream(streamReference, { key: threadKey });
        let active = true;

        // Consumed in a background IIFE so this stays synchronous; `cancel()` is
        // what the teardown below uses to stop it.
        (async () => {
            try {
                for await (const event of iterable) {
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `active` is flipped to `false` by the teardown closure between awaits; TS's static flow analysis can't see the async mutation, so this guard is real, not dead.
                    if (!active) {
                        return;
                    }

                    liveEvents = [...liveEvents, event];
                    recomputeStreamingText();
                }
            } catch {
                // The stream ended in error. `streamingText` keeps its last value
                // and the durable history remains the source of truth — a token
                // stream has no error channel of its own on this handle.
            }
        })().catch(() => {
            // Unreachable: the IIFE's own try/catch swallows every rejection.
        });

        return () => {
            active = false;
            iterable.cancel();
        };
    };

    const unsubscribeStream = openTokenStream();

    const historyArgs = limit === undefined ? { key: threadKey } : { key: threadKey, limit };
    const unsubscribeHistory = isBrowser()
        ? client.subscribe(api.agents.agentMessages, historyArgs, (value) => {
              durable = value as unknown as ReadonlyArray<AgentChatMessage>;
              recompute();
              recomputeStreamingText();
          })
        : (): void => undefined;
    const unsubscribeThread = isBrowser()
        ? client.subscribe(api.agents.agentThread, { key: threadKey }, (value) => {
              latestThread = value as AgentThreadRecord | undefined;
              statusBox.set(latestThread?.status);
          })
        : (): void => undefined;

    const send = async (input: string, arguments_?: Record<string, unknown>): Promise<void> => {
        const id = nextId;

        nextId += 1;

        // Capture the reconcile baseline: the highest durable `seq` present now, so
        // only a matching user row that lands AFTER this send retires the row.
        const maxDurableSeqAtSend = maxSeq(durable);

        // Prune already-acknowledged optimistic rows as we add the new one, so the
        // list stays bounded, then reflect it immediately.
        optimistic = [...reconcileOptimistic(optimistic, durable), { content: input, id, maxDurableSeqAtSend }];
        recompute();

        try {
            await sendMutation.mutate({ input, threadKey, ...sendArgs, ...arguments_ });
        } catch (error) {
            // The mutation never landed, so no durable user turn will ever
            // reconcile this optimistic row away — drop it by id so a failed
            // send doesn't leave a permanent ghost message, then rethrow so
            // the caller can surface the failure.
            optimistic = optimistic.filter((pending) => pending.id !== id);
            recompute();

            throw error;
        }
    };

    const resolveApproval = async (decision: "approve" | "reject", toolCallId: string, note?: string): Promise<void> => {
        const instanceId = latestThread?.instanceId;

        if (instanceId === undefined) {
            throw new Error(`agentChat: cannot ${decision} — no in-flight run (thread has no instanceId)`);
        }

        await approvalMutation.mutate({ decision, instanceId, threadKey, toolCallId, ...(note === undefined ? {} : { note }) });
    };

    const approve = async (toolCallId: string, note?: string): Promise<void> => resolveApproval("approve", toolCallId, note);

    const reject = async (toolCallId: string, note?: string): Promise<void> => resolveApproval("reject", toolCallId, note);

    const cancel = async (): Promise<void> => {
        const instanceId = latestThread?.instanceId;

        // No cancel path, or no run to cancel — nothing to terminate.
        if (cancelReference === undefined || instanceId === undefined) {
            return;
        }

        await cancelMutation.mutate({ instanceId, threadKey });
    };

    const teardown = (): void => {
        unsubscribeHistory();
        unsubscribeThread();
        unsubscribeStream();
    };

    return {
        approve,
        cancel,
        get messages() {
            return messagesBox.current;
        },
        reject,
        send,
        get status() {
            return statusBox.current;
        },
        get streamingText() {
            return streamingTextBox.current;
        },
        teardown,
    };
};

/**
 * A first-class agent chat surface: live durable history + in-flight token
 * streaming + the send / approve / reject / cancel writes, keyed by `threadKey` —
 * the Svelte counterpart to React's `useAgentChat`.
 *
 * It composes the existing primitives rather than adding transport:
 * `client.subscribe(api.agents.agentMessages)` for durable history,
 * `client.subscribe(api.agents.agentThread)` for live status + the in-flight
 * `instanceId`, `client.stream(...)` over an app token stream for in-flight
 * deltas, and {@link mutation} for the writes (`api.agents.agentResolveApproval` for approvals;
 * app-defined wrappers for `send`/`cancel`). Only the `agents:*` surface is
 * hard-coded — `send`/`cancel`/`stream` stay generic references.
 *
 * A `send` optimistically appends the user turn so it renders immediately; the
 * optimistic row clears once the durable history carries the acknowledged turn.
 * `streamingText` is live-only: it holds the current turn's streamed text and
 * empties as soon as that turn's assistant message lands in `messages` (the
 * persisted message is the source of truth); with no `stream` reference it stays
 * `""` and the UI advances message-by-message from durable history. The
 * subscriptions (and the token stream, if any) open eagerly and run until
 * {@link AgentChatHandle.teardown} — call `onDestroy(handle.teardown)`.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published by
 * `setLunoraClient`.
 */
export function agentChat(options: AgentChatOptions): AgentChatHandle;
export function agentChat(client: LunoraClient, options: AgentChatOptions): AgentChatHandle;
export function agentChat(clientOrOptions: AgentChatOptions | LunoraClient, maybeOptions?: AgentChatOptions): AgentChatHandle {
    const hasExplicitClient = isClient(clientOrOptions);
    const client = hasExplicitClient ? clientOrOptions : getLunoraClient();
    const options = (hasExplicitClient ? maybeOptions : clientOrOptions) as AgentChatOptions;

    return createAgentChatHandle(client, options);
}

export type { AgentChatApi, AgentChatHandle, AgentChatMessage, AgentChatOptions, AgentLiveEvent, AgentProgressEvent, AgentTokenDelta };
