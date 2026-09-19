import { activateVersion, listVersions, saveVersion, type Scope } from "@/core/platform/prompts";
import { AGENT_KEYS, type AgentKey } from "@/core/types";
import { actorFrom, bad, failed, jsonBody, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

const validScope = (scope: string): scope is Scope =>
  scope === "campaign" || AGENT_KEYS.includes(scope as AgentKey);

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return ok({ versions: await listVersions(id) });
  } catch (err) {
    return failed(err, "list prompt versions");
  }
}

/** Saving never mutates a version — it creates the next one. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await jsonBody<{
      scope?: string;
      content?: string;
      note?: string;
      activate?: boolean;
    }>(request);
    if (!body.scope || !validScope(body.scope)) {
      return bad("scope must be 'campaign' or an agent key");
    }
    if (!body.content?.trim()) return bad("content is required");

    const version = await saveVersion({
      campaignId: id,
      scope: body.scope,
      content: body.content,
      note: body.note ?? "",
      author: actorFrom(request),
      activate: body.activate ?? true,
    });
    return ok({ version });
  } catch (err) {
    return failed(err, "save prompt version");
  }
}

/** Activate a version — which is also how rollback works. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await jsonBody<{ versionId?: string }>(request);
    if (!body.versionId) return bad("versionId is required");
    const version = await activateVersion(id, body.versionId, actorFrom(request));
    if (!version) return bad("version not found for this campaign", 404);
    return ok({ version });
  } catch (err) {
    return failed(err, "activate prompt version");
  }
}
