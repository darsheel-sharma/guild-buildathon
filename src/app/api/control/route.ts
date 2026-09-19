import { isKillSwitchOn, setKillSwitch } from "@/core/platform/control";
import { actorFrom, bad, failed, jsonBody, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/** The global kill switch. One flag, checked by every gate in the platform. */
export async function POST(request: Request) {
  try {
    const body = await jsonBody<{ on?: boolean; reason?: string }>(request);
    if (typeof body.on !== "boolean") return bad("`on` must be a boolean");
    await setKillSwitch(
      body.on,
      body.reason?.slice(0, 300) || "engaged from the dashboard",
      actorFrom(request),
    );
    return ok(await isKillSwitchOn());
  } catch (err) {
    return failed(err, "kill switch");
  }
}

export async function GET() {
  try {
    return ok(await isKillSwitchOn());
  } catch (err) {
    return failed(err, "kill switch read");
  }
}
