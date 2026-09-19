import { getPauseState, setAgentPaused, setChannelPaused } from "@/core/platform/control";
import { AGENT_KEYS, CHANNELS, type AgentKey, type Channel } from "@/core/types";
import { actorFrom, bad, failed, jsonBody, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Agent-level and channel-level pause. Separate from campaign pause on purpose:
 * stopping the voice agent must not stop email.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const actor = actorFrom(request);
    const body = await jsonBody<{ agent?: string; channel?: string; paused?: boolean }>(request);
    if (typeof body.paused !== "boolean") return bad("`paused` must be a boolean");

    if (body.agent) {
      if (!AGENT_KEYS.includes(body.agent as AgentKey)) return bad("unknown agent");
      await setAgentPaused(id, body.agent as AgentKey, body.paused, actor);
    } else if (body.channel) {
      if (!CHANNELS.includes(body.channel as Channel)) return bad("unknown channel");
      await setChannelPaused(id, body.channel as Channel, body.paused, actor);
    } else {
      return bad("pass either `agent` or `channel`");
    }
    return ok(await getPauseState(id));
  } catch (err) {
    return failed(err, "pause toggle");
  }
}
