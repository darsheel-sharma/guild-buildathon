import Link from "next/link";
import { notFound } from "next/navigation";
import { PromptWorkbench } from "@/components/prompt-workbench";
import { StatusPill } from "@/components/ui";
import { getCampaign } from "@/core/platform/campaigns";
import { listVersions } from "@/core/platform/prompts";
import { AGENT_KEYS, AGENT_LABELS } from "@/core/types";

export const dynamic = "force-dynamic";

export default async function PromptsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const campaign = await getCampaign(id);
  if (!campaign) notFound();

  const versions = await listVersions(id);

  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Link href="/" className="text-xs text-ink-faint hover:text-ink">
            Campaigns
          </Link>
          <span className="text-xs text-ink-faint">/</span>
          <Link href={`/campaigns/${id}`} className="text-xs text-ink-faint hover:text-ink">
            {campaign.name}
          </Link>
          <span className="text-xs text-ink-faint">/</span>
          <h1 className="text-lg font-medium">Prompts & versions</h1>
          <StatusPill status={campaign.status} />
        </div>
        <p className="mt-1.5 max-w-3xl text-[13px] text-ink-soft">
          Prompts are immutable versions, not editable fields. Saving creates the next version;
          rolling back is activating an older one. Every agent run stores the version it used, so
          any outcome can be traced back to the configuration that produced it — and editing this
          campaign cannot change any other campaign&apos;s behaviour.
        </p>
      </div>

      <PromptWorkbench
        campaignId={id}
        campaignName={campaign.name}
        versions={versions}
        scopes={[
          { key: "campaign", label: "Campaign system prompt" },
          ...AGENT_KEYS.map((key) => ({ key, label: AGENT_LABELS[key] })),
        ]}
      />
    </div>
  );
}
