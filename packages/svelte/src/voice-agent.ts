import type { FunctionReference, LunoraClient } from "@lunora/client";

import { isClient } from "./agent";
import { getLunoraClient } from "./context";
import { box } from "./reactive";
import type { CreateMicrophone, CreateSpeaker, VoiceAudioFormat, VoiceMicrophone, VoiceSpeaker } from "./voice-audio";
import { createBrowserMicrophone, createBrowserSpeaker } from "./voice-audio";

/**
 * A server-to-client control frame (JSON). Client-safe mirror of
 * `@lunora/agent`'s `VoiceServerFrame`. Audio never rides these frames — it
 * arrives as separate binary WebSocket messages.
 */
type VoiceServerFrame =
    | { audioFormat: VoiceAudioFormat; type: "ready" }
    | { message: string; type: "error" }
    | { text: string; type: "assistant_delta" }
    | { text: string; type: "assistant_done" }
    | { text: string; type: "user_transcript" }
    | { type: "interrupted" };

/**
 * A client-to-server control frame (JSON). Client-safe mirror of
 * `@lunora/agent`'s `VoiceClientFrame`. `text` submits a typed turn (no audio);
 * `commit` closes the current spoken utterance; `interrupt` barges in on an
 * in-flight assistant turn.
 */
type VoiceClientFrame = { text: string; type: "text" } | { type: "commit" } | { type: "interrupt" };

/**
 * The `agents.<name>Voice` reference codegen emits for a voice-enabled agent — a
 * live, WS-backed session keyed by `threadKey`. A structural subset of the
 * generated member, so passing `api.agents.<name>Voice` type-checks.
 */
type VoiceReference = FunctionReference<"stream", { threadKey: string }, Record<string, unknown>>;

/** The lifecycle of a voice call, mirrored to the UI. */
type VoiceStatus = "idle" | "listening" | "speaking" | "thinking";

/** A minimal structural subset of the DOM `WebSocket` the handle drives. */
interface VoiceSocket {
    binaryType: string;
    close: () => void;
    onclose: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;

    onmessage: ((event: { data: unknown }) => void) | null;
    onopen: ((event: unknown) => void) | null;
    readonly readyState: number;
    send: (data: ArrayBufferView | ArrayBufferLike | string) => void;
}

type CreateSocket = (url: string) => VoiceSocket;

interface VoiceAgentOptions {
    /**
     * Advanced/test seam: build the microphone capture subsystem. Defaults to a
     * `getUserMedia` + Web Audio implementation. Injected wholesale so the Web
     * Audio graph stays isolated (and mockable in a non-browser test env).
     */
    createMicrophone?: CreateMicrophone;
    /** Advanced/test seam: open the transport. Defaults to `new WebSocket(url)`. */
    createSocket?: CreateSocket;
    /** Advanced/test seam: build the audio playback subsystem. Defaults to a Web Audio implementation. */
    createSpeaker?: CreateSpeaker;

    /** Consecutive above-`interruptThreshold` chunks that trigger a barge-in. Default `3`. */
    interruptChunks?: number;
    /** Input RMS above which the user is treated as barging in while the agent speaks. Default `0.15`. */
    interruptThreshold?: number;
    /** Milliseconds of silence (after speech) that auto-commits an utterance. Default `1200`. */
    silenceDurationMs?: number;
    /** Input RMS below which audio counts as silence. Default `0.01`. */
    silenceThreshold?: number;
    /** The thread to converse on — shared with the agent's text turns. */
    threadKey: string;
    /** The generated `api.agents.<name>Voice` reference — identifies the voice DO endpoint. */
    voice: VoiceReference;
}

interface VoiceAgentHandle {
    /** The current input RMS (0–1) — drive a mic level meter. */
    readonly audioLevel: number;
    /** `true` once the WS `ready` handshake completed. */
    readonly connected: boolean;
    /** Tear down the call: close the socket, stop the mic, release audio. Idempotent. Call in `onDestroy`. */
    endCall: () => void;
    /** The last transport/pipeline error, or `undefined`. */
    readonly error: Error | undefined;
    /** The live assistant text for the in-flight turn (grows via deltas; finalized on done). */
    readonly interimTranscript: string;
    /** `true` while the mic is muted. */
    readonly isMuted: boolean;
    /** Send a typed turn (no audio) — a text message spoken back by the agent. */
    sendText: (text: string) => void;
    /** Open the mic, connect the socket, and start the conversation. Idempotent while active. */
    startCall: () => Promise<void>;
    /** The current call lifecycle. */
    readonly status: VoiceStatus;
    /** Mute/unmute the microphone. Returns the new muted state. */
    toggleMute: () => boolean;
    /** The last finalized user utterance (STT result). */
    readonly transcript: string;
}

/** WebSocket `readyState` OPEN, read structurally so no DOM `WebSocket` global is required at module load. */
const WS_OPEN = 1;

const DEFAULT_SILENCE_THRESHOLD = 0.01;
const DEFAULT_SILENCE_DURATION_MS = 1200;
const DEFAULT_INTERRUPT_THRESHOLD = 0.15;
const DEFAULT_INTERRUPT_CHUNKS = 3;

/** Swap an http(s) origin for its ws(s) equivalent — mirrors the client's own derivation. */
const deriveWebSocketUrl = (url: string): string => {
    if (url.startsWith("https://")) {
        return `wss://${url.slice("https://".length)}`;
    }

    if (url.startsWith("http://")) {
        return `ws://${url.slice("http://".length)}`;
    }

    return url;
};

/**
 * Derive the agent's export name from its voice reference. Codegen emits the
 * member as `agents.<name>Voice` (ref `agents:<name>Voice`), so strip the
 * `agents:` namespace and the `Voice` suffix.
 */
const agentNameFromReference = (voice: VoiceReference): string => {
    const reference = voice["__lunoraRef"];
    const withoutNamespace = reference.startsWith("agents:") ? reference.slice("agents:".length) : reference;

    return withoutNamespace.endsWith("Voice") ? withoutNamespace.slice(0, -"Voice".length) : withoutNamespace;
};

/** Build the voice-session WebSocket URL for `agent` on `threadKey`. */
const voiceSocketUrl = (baseUrl: string, agent: string, threadKey: string): string => {
    const base = deriveWebSocketUrl(baseUrl);
    const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
    const search = new URLSearchParams({ threadKey });

    return `${trimmed}/_lunora/voice/${encodeURIComponent(agent)}?${search.toString()}`;
};

/** Mutable per-call connection state, held in a closure so callbacks share one source of truth. */
interface VoiceConnection {
    audioFormat: VoiceAudioFormat;
    microphone: VoiceMicrophone | undefined;
    socket: VoiceSocket;
    speaker: VoiceSpeaker | undefined;
    speaking: boolean;

    /**
     * Set on a LOCAL barge-in to drop inbound audio frames until the server acks
     * the interrupt — otherwise audio already in flight (queued before the DO saw
     * the `interrupt`) would resurrect a speaker the user just silenced. Cleared
     * on the next `interrupted` / `user_transcript` / `ready` frame.
     */
    suppressAudio: boolean;
}

const createVoiceAgentHandle = (client: LunoraClient, options: VoiceAgentOptions): VoiceAgentHandle => {
    const {
        createMicrophone = createBrowserMicrophone,
        createSpeaker = createBrowserSpeaker,
        createSocket,
        interruptChunks = DEFAULT_INTERRUPT_CHUNKS,
        interruptThreshold = DEFAULT_INTERRUPT_THRESHOLD,
        silenceDurationMs = DEFAULT_SILENCE_DURATION_MS,
        silenceThreshold = DEFAULT_SILENCE_THRESHOLD,
        threadKey,
        voice,
    } = options;

    const statusBox = box<VoiceStatus>("idle");
    const connectedBox = box(false);
    const transcriptBox = box("");
    const interimTranscriptBox = box("");
    const audioLevelBox = box(0);
    const isMutedBox = box(false);
    const errorBox = box<Error | undefined>(undefined);

    // The live per-call connection (React's `connectionRef.current`) and the
    // "start in flight" guard (React's `startingRef.current`) — plain closure
    // variables, since a handle instance is created once per component.
    let current: VoiceConnection | undefined;
    let starting = false;

    const sendFrame = (frame: VoiceClientFrame): boolean => {
        const socket = current?.socket;

        if (socket?.readyState === WS_OPEN) {
            socket.send(JSON.stringify(frame));

            return true;
        }

        return false;
    };

    const teardown = (): void => {
        const connection = current;

        current = undefined;

        if (connection) {
            connection.microphone?.stop();
            connection.speaker?.stop();

            try {
                connection.socket.close();
            } catch {
                /* already closed */
            }
        }

        starting = false;
        connectedBox.set(false);
        statusBox.set("idle");
        audioLevelBox.set(0);
    };

    const endCall = teardown;

    const handleServerFrame = (frame: VoiceServerFrame): void => {
        const connection = current;

        switch (frame.type) {
            case "assistant_delta": {
                if (connection) {
                    connection.speaking = true;
                }

                statusBox.set("speaking");
                interimTranscriptBox.set(interimTranscriptBox.current + frame.text);

                break;
            }
            case "assistant_done": {
                if (connection) {
                    connection.speaking = false;
                }

                interimTranscriptBox.set(frame.text);
                statusBox.set("listening");

                break;
            }
            case "error": {
                // A non-fatal turn failure: surface it and return the call to a
                // usable state rather than leaving it stuck "speaking"/"thinking".
                if (connection) {
                    connection.speaking = false;
                }

                errorBox.set(new Error(frame.message));
                statusBox.set("listening");

                break;
            }
            case "interrupted": {
                if (connection) {
                    connection.speaking = false;
                    connection.suppressAudio = false;
                }

                connection?.speaker?.interrupt();
                statusBox.set("listening");

                break;
            }
            case "ready": {
                if (connection) {
                    connection.audioFormat = frame.audioFormat;
                    connection.suppressAudio = false;
                }

                connectedBox.set(true);
                statusBox.set("listening");

                break;
            }
            case "user_transcript": {
                if (connection) {
                    connection.suppressAudio = false;
                }

                transcriptBox.set(frame.text);
                interimTranscriptBox.set("");
                statusBox.set("thinking");

                break;
            }
            default: {
                break;
            }
        }
    };

    const handleAudioChunk = (audio: Uint8Array): void => {
        const connection = current;

        if (!connection || connection.suppressAudio) {
            return;
        }

        connection.speaker ??= createSpeaker({ audioFormat: connection.audioFormat });
        connection.speaking = true;
        statusBox.set("speaking");
        connection.speaker.enqueue(audio);
    };

    const startCall = async (): Promise<void> => {
        if (current || starting) {
            return;
        }

        starting = true;
        errorBox.set(undefined);
        transcriptBox.set("");
        interimTranscriptBox.set("");

        try {
            const url = voiceSocketUrl(client.url, agentNameFromReference(voice), threadKey);
            const openSocket: CreateSocket =
                createSocket ?? ((target) => new (globalThis as unknown as { WebSocket: new (u: string) => VoiceSocket }).WebSocket(target));
            const socket = openSocket(url);

            socket.binaryType = "arraybuffer";

            const connection: VoiceConnection = {
                audioFormat: "mp3",
                microphone: undefined,
                socket,
                speaker: undefined,
                speaking: false,
                suppressAudio: false,
            };

            current = connection;

            // The injectable `VoiceSocket` exposes only `on*` handler slots (not a
            // real EventTarget), so assign them directly.
            /* eslint-disable unicorn/prefer-add-event-listener */
            socket.onmessage = (event): void => {
                if (typeof event.data === "string") {
                    try {
                        handleServerFrame(JSON.parse(event.data) as VoiceServerFrame);
                    } catch {
                        /* ignore malformed control frame */
                    }

                    return;
                }

                handleAudioChunk(new Uint8Array(event.data as ArrayBuffer));
            };

            socket.onerror = (): void => {
                errorBox.set(new Error("voiceAgent: voice socket error"));
            };

            socket.onclose = (): void => {
                if (current === connection) {
                    teardown();
                }
            };
            /* eslint-enable unicorn/prefer-add-event-listener */

            const microphone = await createMicrophone({
                interruptChunks,
                interruptThreshold,
                isSpeaking: () => current?.speaking ?? false,
                onAudio: (pcm) => {
                    if (socket.readyState === WS_OPEN) {
                        socket.send(pcm);
                    }
                },
                onInterrupt: () => {
                    sendFrame({ type: "interrupt" });
                    current?.speaker?.interrupt();

                    if (current) {
                        current.speaking = false;
                        // Drop any audio already in flight until the server acks —
                        // cleared on the next `interrupted`/`user_transcript`/`ready`.
                        current.suppressAudio = true;
                    }

                    statusBox.set("listening");
                },
                onLevel: (rms) => {
                    audioLevelBox.set(rms);
                },
                onSilence: () => {
                    sendFrame({ type: "commit" });
                    statusBox.set("thinking");
                },
                silenceDurationMs,
                silenceThreshold,
            });

            // The call may have been torn down while getUserMedia was pending.
            if (current === connection) {
                connection.microphone = microphone;
                isMutedBox.set(false);
                // Optimistically show "listening" once the mic is live — the server's
                // `ready` frame follows and flips `connected` true.
                statusBox.set("listening");
            } else {
                microphone.stop();
            }
        } catch (error_) {
            errorBox.set(error_ instanceof Error ? error_ : new Error(String(error_)));
            teardown();
        } finally {
            starting = false;
        }
    };

    const toggleMute = (): boolean => {
        const next = !isMutedBox.current;

        current?.microphone?.setMuted(next);
        isMutedBox.set(next);

        return next;
    };

    const sendText = (text: string): void => {
        // Only advance to "thinking" if the frame actually reached an open socket;
        // otherwise the UI would stick in "thinking" with no call.
        if (sendFrame({ text, type: "text" })) {
            statusBox.set("thinking");
        }
    };

    return {
        get audioLevel() {
            return audioLevelBox.current;
        },
        get connected() {
            return connectedBox.current;
        },
        endCall,
        get error() {
            return errorBox.current;
        },
        get interimTranscript() {
            return interimTranscriptBox.current;
        },
        get isMuted() {
            return isMutedBox.current;
        },
        sendText,
        startCall,
        get status() {
            return statusBox.current;
        },
        toggleMute,
        get transcript() {
            return transcriptBox.current;
        },
    };
};

/**
 * A first-class voice-call surface for a voice-enabled agent: it opens a
 * WebSocket to the agent's `VoiceSessionDO`, captures mic audio as 16 kHz PCM,
 * streams the agent's synthesized speech back through the browser's audio output,
 * and mirrors the call lifecycle (`status`, `transcript`, `interimTranscript`,
 * `audioLevel`) onto reactive properties of the returned handle. Pass the
 * generated `api.agents.<name>Voice` reference (never a string), matching
 * `agentChat`'s reference-passing style. The Svelte counterpart to React's
 * `useVoiceAgent`; the per-call connection lives in a closure variable, since a
 * handle is created once per component and nothing needs to observe the
 * connection itself.
 *
 * v1 transport is plain binary WebSocket frames with push-to-talk / silence-timer
 * turn detection and client-side RMS barge-in. The heavy Web Audio capture and
 * playback subsystems are injectable (`createMicrophone` / `createSpeaker` /
 * `createSocket`) so the handle is drivable outside a browser.
 *
 * There is no auto-dispose in Svelte — call `endCall` in `onDestroy`
 * (`onDestroy(handle.endCall)`) to tear the call down if the component unmounts
 * mid-call.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published by
 * `setLunoraClient`.
 */
export function voiceAgent(options: VoiceAgentOptions): VoiceAgentHandle;
export function voiceAgent(client: LunoraClient, options: VoiceAgentOptions): VoiceAgentHandle;
export function voiceAgent(clientOrOptions: VoiceAgentOptions | LunoraClient, maybeOptions?: VoiceAgentOptions): VoiceAgentHandle {
    const hasExplicitClient = isClient(clientOrOptions);
    const client = hasExplicitClient ? clientOrOptions : getLunoraClient();
    const options = (hasExplicitClient ? maybeOptions : clientOrOptions) as VoiceAgentOptions;

    return createVoiceAgentHandle(client, options);
}

export type { VoiceAgentHandle, VoiceAgentOptions, VoiceReference, VoiceStatus };
export type { VoiceAudioFormat } from "./voice-audio";
