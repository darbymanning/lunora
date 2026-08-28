import type { FunctionReference } from "@lunora/client";
import { describe, expect, it } from "vitest";

import type { StreamHandle } from "../src/stream";
import { stream } from "../src/stream";
import { createFakeClient } from "./fake-client";
import { track } from "./track";

const makeStreamRef = (reference: string): FunctionReference<"stream"> => {
    return { __lunoraRef: reference };
};

const TICK_REF = "metrics:tick";

describe(stream, () => {
    it("opens a stream on the first tracked read and appends chunks as they arrive", async () => {
        const fake = createFakeClient();
        const handle: StreamHandle<unknown> = stream(fake.client, makeStreamRef(TICK_REF), { since: 0 });

        // The handle is lazy — the stream opens on the first tracked read.
        const reader = track(() => handle.chunks);

        expect(fake.streamCalls.map((call) => call.functionPath)).toStrictEqual([TICK_REF]);
        expect(handle.status).toBe("streaming");

        fake.pushStream(TICK_REF, { tick: 1 });
        fake.pushStream(TICK_REF, { tick: 2 });
        await fake.flush();

        expect(handle.chunks).toStrictEqual([{ tick: 1 }, { tick: 2 }]);

        fake.streamCalls[0]?.handle.complete();
        await fake.flush();

        expect(handle.status).toBe("complete");

        reader.stop();
    });

    it("'skip' keeps the handle usable without opening a stream", () => {
        const fake = createFakeClient();
        const handle = stream(fake.client, makeStreamRef(TICK_REF), "skip");

        const reader = track(() => handle.chunks);

        expect(fake.streamCalls).toHaveLength(0);
        expect(handle.status).toBe("idle");
        expect(handle.chunks).toStrictEqual([]);

        reader.stop();
    });

    it("cancels the in-flight iterator on teardown", () => {
        const fake = createFakeClient();
        const handle = stream(fake.client, makeStreamRef(TICK_REF), { since: 0 });

        const reader = track(() => handle.chunks);

        expect(fake.streamCalls).toHaveLength(1);

        handle.teardown();

        expect(fake.streamCalls[0]?.onCancel).toHaveBeenCalledWith();

        reader.stop();
    });

    it("cancels the in-flight iterator when the last reader detaches", () => {
        const fake = createFakeClient();
        const handle = stream(fake.client, makeStreamRef(TICK_REF), { since: 0 });

        const reader = track(() => handle.chunks);

        expect(fake.streamCalls).toHaveLength(1);

        reader.stop();

        expect(fake.streamCalls[0]?.onCancel).toHaveBeenCalledWith();
    });

    it("surfaces a server error and transitions status to 'error'", async () => {
        const fake = createFakeClient();
        const handle = stream(fake.client, makeStreamRef(TICK_REF), { since: 0 });

        const reader = track(() => handle.chunks);

        fake.streamCalls[0]?.handle.fail(new Error("forbidden"));
        await fake.flush();

        expect(handle.status).toBe("error");
        expect(handle.error?.message).toBe("forbidden");

        reader.stop();
    });
});
