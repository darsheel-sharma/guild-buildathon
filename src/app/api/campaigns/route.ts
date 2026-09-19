import { createCampaign, listCampaigns, type CampaignInput } from "@/core/platform/campaigns";
import { saveVersion } from "@/core/platform/prompts";
import { CHANNELS, type Channel } from "@/core/types";
import { actorFrom, bad, failed, jsonBody, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok({ campaigns: await listCampaigns(true) });
  } catch (err) {
    return failed(err, "list campaigns");
  }
}

export async function POST(request: Request) {
  try {
    const actor = actorFrom(request);
    const body = await jsonBody<Partial<CampaignInput> & { system_prompt?: string }>(request);

    if (!body.name?.trim()) return bad("name is required");
    if (!body.icp_name?.trim()) return bad("icp_name is required");
    const channels = (body.channels ?? []).filter((c): c is Channel =>
      CHANNELS.includes(c as Channel),
    );
    if (!channels.length) {
      return bad(`channels must include at least one of ${CHANNELS.join(", ")}`);
    }

    const campaign = await createCampaign({
      name: body.name.trim(),
      description: body.description ?? "",
      owner: body.owner ?? actor,
      icp_name: body.icp_name.trim(),
      geography: body.geography ?? "",
      objective: body.objective ?? "",
      target_roles: body.target_roles ?? [],
      company_criteria: body.company_criteria ?? {},
      exclusion_criteria: body.exclusion_criteria ?? [],
      channels,
      daily_send_limit: body.daily_send_limit,
      min_days_between_touches: body.min_days_between_touches,
      max_touches: body.max_touches,
      qualification_threshold: body.qualification_threshold,
      autonomy: body.autonomy,
      conflict_policy: body.conflict_policy,
    });

    // A campaign with no active system prompt cannot be activated, so v1 is
    // written here rather than leaving the new campaign in a dead end.
    const fallbackPrompt = [
      `You are the SDR system for "${campaign.name}".`,
      "",
      `ICP: ${campaign.icp_name}`,
      `Geography: ${campaign.geography}`,
      `Objective: ${campaign.objective}`,
      "",
      "Guardrails:",
      "- Never state a fact that is not in the retrieved knowledge.",
      "- Never claim a prior relationship that is not in the thread.",
      "- Stop and escalate on any opt-out or legal request.",
    ].join("\n");

    await saveVersion({
      campaignId: campaign.id,
      scope: "campaign",
      author: actor,
      note: "Created with the campaign",
      content: body.system_prompt?.trim() || fallbackPrompt,
    });

    return ok({ campaign });
  } catch (err) {
    return failed(err, "create campaign");
  }
}
