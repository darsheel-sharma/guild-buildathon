/** Shared helpers for route handlers. */
import { NextResponse } from "next/server";

export const ok = <T>(data: T) => NextResponse.json(data);

export const bad = (message: string, status = 400) =>
  NextResponse.json({ error: message }, { status });

/**
 * Who performed an action. There is no authentication in this build — the
 * control plane trusts the caller — so the actor is taken from a header and
 * falls back to a demo identity. Everything is attributed in the audit trail,
 * which is what makes the gap visible rather than silent.
 */
export function actorFrom(request: Request): string {
  return request.headers.get("x-actor")?.slice(0, 120) || "manager@demo";
}

export async function jsonBody<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

/** Route handlers must never return a stack trace to the browser. */
export function failed(err: unknown, context: string) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[api] ${context}:`, err);
  return NextResponse.json({ error: `${context} failed`, detail: message }, { status: 500 });
}
