import { ensureDemoActivity } from "@/core/db/seed";
import { channelTransports } from "@/core/platform/channels";
import { isKillSwitchOn } from "@/core/platform/control";
import { listEvents } from "@/core/platform/events";
import { configuredAgents } from "@/core/platform/dronahq";
import { hasLiveModel, modelFor } from "@/core/platform/llm";
import { AGENT_KEYS } from "@/core/types";
import { overview } from "@/core/platform/metrics";
import { failed, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // First request after a cold start builds the demo history by running the
    // real orchestrator. Later requests skip straight past it.
    await ensureDemoActivity();
    const [campaigns, kill, events] = await Promise.all([
      overview(),
      isKillSwitchOn(),
      listEvents(null, 25),
    ]);
    return ok({
      campaigns,
      killSwitch: kill,
      transports: channelTransports(),
      intelligence: {
        mode: hasLiveModel() ? "live" : "simulated",
        dronahqAgents: configuredAgents(AGENT_KEYS),
        fast: modelFor("fast"),
        strong: modelFor("strong"),
      },
      events,
    });
  } catch (err) {
    return failed(err, "overview");
  }
}
