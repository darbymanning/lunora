import type { FunctionReference } from "@lunora/client";
import { describe, expect, it } from "vitest";

import type { AgentStateApi } from "../src/agent-state";
import { agentState } from "../src/agent-state";
import { createFakeClient } from "./fake-client";
import { flush, track } from "./track";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const STATE_REF = "agents:agentState";

interface SupportState extends Record<string, unknown> {
    plan: string[];
    step: number;
}

const buildApi = (): AgentStateApi =>
    ({
        agents: {
            agentState: makeRef(STATE_REF),
        },
    }) as unknown as AgentStateApi;

describe(agentState, () => {
    it("subscribes to agents.agentState under the thread key and is undefined before the first frame", () => {
        const fake = createFakeClient();
        const handle = agentState(fake.client, { api: buildApi(), threadKey: "t1" });

        // The handle is lazy — the subscription opens on the first tracked read.
        const reader = track(() => handle.state);

        expect(fake.subscribeCalls.map((call) => call.functionPath)).toStrictEqual([STATE_REF]);
        expect(fake.subscribeCalls[0]?.args).toStrictEqual({ key: "t1" });
        expect(reader.last).toBeUndefined();
        expect(handle.error).toBeUndefined();

        // Dropping the last reader tears the underlying subscription down.
        reader.stop();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(1);
    });

    it("flows the live synced state through the subscription and reflects later absolute frames", () => {
        const fake = createFakeClient();
        const handle = agentState<SupportState>(fake.client, { api: buildApi(), threadKey: "t1" });

        const reader = track(() => handle.state);

        fake.push(STATE_REF, { plan: ["research"], step: 1 });
        flush();

        expect(reader.last).toStrictEqual({ plan: ["research"], step: 1 });

        // A later setState pushes a fresh absolute frame — the handle reflects it wholesale.
        fake.push(STATE_REF, { plan: ["research", "draft"], step: 2 });
        flush();

        expect(reader.last).toStrictEqual({ plan: ["research", "draft"], step: 2 });

        reader.stop();
    });
});
