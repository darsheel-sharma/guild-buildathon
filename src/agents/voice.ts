/**
 * Voice SDR agent.
 *
 * Plans a call rather than writing a message: an opening, the questions that
 * qualify the prospect, the objections likely on this ICP, and an explicit
 * escalation trigger. The plan's opening is what the telephony adapter speaks;
 * the questions and escalation rule are what keep the call from wandering.
 */
import { z } from "zod";
import type { Campaign, Prospect, ResearchOutput } from "@/core/types";
import { runAgent, type AgentContext, type AgentOutcome } from "./runtime";

const schema = z.object({
  opening: z.string().max(600),
  objective: z.string().max(200),
  qualification_questions: z.array(z.string()).min(1).max(4),
  likely_objections: z.array(z.string()).max(3),
  escalate_if: z.string().max(200),
  compliance_line: z.string().max(300).optional(),
  voicemail_script: z.string().max(400).optional(),
});

export interface CallPlan {
  opening: string;
  objective: string;
  qualification_questions: string[];
  likely_objections: string[];
  escalate_if: string;
  /** Disclosure the rep opens with. */
  compliance_line?: string;
  /** Under 15 seconds, for when the call goes to voicemail. */
  voicemail_script?: string;
}

/**
 * The disclosure the caller opens with. No campaign field carries this yet,
 * so it is a fixed default, kept here rather than in the prompt so it is one
 * edit away from becoming per-campaign.
 */
const DEFAULT_COMPLIANCE_LINE =
  "Open by naming yourself and the company you are calling on behalf of, and say why you are calling, " +
  "before anything else. If asked directly whether this is an automated call, answer plainly and honestly.";

function toStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0).slice(0, max);
}

/**
 * The DronaHQ Voice SDR Agent runs here as an ordinary text agent: it plans
 * the call, a human rep makes it. Conducting the call inside DronaHQ needs
 * their Enterprise tier, and planning is the half that carries the reasoning
 * anyway.
 */
export function normalizeCallPlan(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  let obj = raw as Record<string, unknown>;

  // Already our shape (simulate()/direct-model paths) — pass through.
  if (typeof obj.opening === "string" && Array.isArray(obj.qualification_questions)) {
    return obj;
  }

  if (typeof obj.response === "string") {
    const text = obj.response.trim();
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
      else throw new Error("not an object");
    } catch {
      throw new Error(`DronaHQ Voice SDR Agent returned unstructured text, not a call plan: ${text.slice(0, 200)}`);
    }
  }

  const hasAnyPlanField =
    "opening" in obj || "objective" in obj || "qualification_questions" in obj || "escalate_if" in obj;
  if (!hasAnyPlanField) {
    throw new Error(
      `DronaHQ Voice SDR Agent did not return a call plan (got: ${JSON.stringify(obj).slice(0, 200)})`,
    );
  }

  const questions = toStringArray(obj.qualification_questions ?? obj.questions, 4);

  return {
    opening: typeof obj.opening === "string" ? obj.opening.slice(0, 600) : "",
    objective: typeof obj.objective === "string" ? obj.objective.slice(0, 200) : "Qualify fit and book a follow-up.",
    // The schema requires at least one question; a plan without any is not a
    // usable brief, so fail rather than hand a rep an empty call.
    qualification_questions: questions.length ? questions : [],
    likely_objections: toStringArray(obj.likely_objections ?? obj.objections, 3),
    escalate_if:
      typeof obj.escalate_if === "string"
        ? obj.escalate_if.slice(0, 200)
        : "The prospect asks about pricing, contracts, security review or legal, or asks for a human.",
    compliance_line: typeof obj.compliance_line === "string" ? obj.compliance_line.slice(0, 300) : undefined,
    voicemail_script: typeof obj.voicemail_script === "string" ? obj.voicemail_script.slice(0, 400) : undefined,
  };
}

export async function planCall(
  campaign: Campaign,
  prospect: Prospect,
  input: {
    campaignProspectId: string;
    research: ResearchOutput | null;
    senderName: string;
  },
): Promise<AgentOutcome<CallPlan>> {
  const first = prospect.full_name.split(" ")[0];
  const pain = input.research?.pain_hypotheses?.[0] ?? "internal tooling has outgrown its owners";

  return runAgent<CallPlan>({
    campaignId: campaign.id,
    campaignProspectId: input.campaignProspectId,
    agent: "voice",
    tier: "strong",
    retrievalQuery: `voice call script qualification questions objection handling ${campaign.icp_name}`,
    retrievalKinds: ["voice_script", "voice", "objection", "playbook"],
    schema,
    seed: `${campaign.id}:${prospect.id}:call`,
    input: { prospect: prospect.email },
    // Named fields for the DronaHQ agent's {{variable.*}} bindings.
    variables: (ctx: AgentContext) => ({
      campaign_name: campaign.icp_name,
      prompt_version: ctx.harness.prompt_version_id,
      call_objective: campaign.objective,
      compliance_line: DEFAULT_COMPLIANCE_LINE,
    }),
    normalize: normalizeCallPlan,
    buildPrompt: ({ knowledge }) => `Plan a cold qualification call.

Campaign objective: ${campaign.objective}
Prospect: ${prospect.full_name}, ${prospect.title} at ${prospect.company} (${prospect.geography})
Research: ${input.research ? input.research.pain_hypotheses.join("; ") : "none"}
Caller: ${input.senderName}

Scripts and objection handling (retrieved):
${knowledge}

Produce a 30-second opening that names the caller and the reason for the call,
two to four questions that would actually qualify or disqualify this prospect,
the objections most likely on this ICP, and one explicit condition under which
the agent must hand the call to a human instead of continuing.`,
    simulate: () => ({
      opening: `Hi ${first}, this is ${input.senderName} — I will keep this to thirty seconds. We work with ${prospect.industry} teams where ${pain}. Is that on your plate this quarter?`,
      objective: `Qualify fit against ${campaign.icp_name} and book a 20-minute technical call.`,
      qualification_questions: [
        "Who owns internal tooling and operational apps today?",
        "How much engineering time goes into admin panels and internal dashboards each month?",
        "Is there a budget line for this, or would it come out of the platform budget?",
      ],
      likely_objections: [
        "We already build this in-house",
        "Data residency and compliance review would take too long",
      ],
      escalate_if:
        "The prospect asks for pricing commitments, raises a legal or security review, or asks to speak to a human.",
    }),
    summarise: (out) => `call plan with ${out.qualification_questions.length} qualifying questions`,
  });
}
