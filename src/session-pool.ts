/**
 * Session Pool — CodeBuddy CLI subprocess reuse across Pi turns.
 *
 * ~3s CLI cold-start saved per turn after the first.
 *
 * Key: cwd + fingerprint of conversation's first user message.
 * Session change detected when the first message differs.
 *
 * Anti-double-history: on continuation, only send new messages
 * (the delta since last send). CodeBuddy session keeps internal context.
 */
import type { Message as CbMessage, Session } from "@tencent-ai/agent-sdk";
import type { Context } from "@earendil-works/pi-ai/compat";

type CodebuddySdk = typeof import("@tencent-ai/agent-sdk");

interface PoolEntry {
  session: Session;
  sentCount: number;
  firstFingerprint: string;
}

const pool = new Map<string, PoolEntry>();

function fingerprintFirstMessage(context: Context): string {
  const first = context.messages[0];
  if (!first || first.role !== "user") return "";
  if (typeof first.content === "string") return first.content.slice(0, 80);
  if (Array.isArray(first.content)) {
    const texts = first.content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text)
      .join(" ");
    return texts.slice(0, 80);
  }
  return "";
}

export async function acquireSession(
  cwd: string,
  sdk: CodebuddySdk,
  context: Context,
  buildFull: (ctx: Context) => string | CbMessage,
  buildDelta: (ctx: Context, startIndex: number) => string | CbMessage,
  sessionOptions: Parameters<CodebuddySdk["unstable_v2_createSession"]>[0],
): Promise<{
  session: Session;
  message: string | CbMessage;
  isFirst: boolean;
}> {
  const key = cwd || process.cwd();
  const fp = fingerprintFirstMessage(context);
  const existing = pool.get(key);

  const isNew = !existing || existing.firstFingerprint !== fp;

  if (isNew) {
    if (existing) {
      try { existing.session.close(); } catch { /* best-effort */ }
    }

    const session = sdk.unstable_v2_createSession(sessionOptions);
    try {
      await session.connect();
    } catch (e) {
      try { session.close(); } catch { /* best-effort, already broken */ }
      throw e;
    }

    const message = buildFull(context);
    pool.set(key, { session, sentCount: context.messages.length, firstFingerprint: fp });
    return { session, message, isFirst: true };
  }

  const deltaStart = existing.sentCount;
  const message =
    deltaStart < context.messages.length
      ? buildDelta(context, deltaStart)
      : "Continue.";

  existing.sentCount = context.messages.length;
  return { session: existing.session, message, isFirst: false };
}

export function evictSession(cwd: string): void {
  const key = cwd || process.cwd();
  const entry = pool.get(key);
  if (entry) {
    try { entry.session.close(); } catch { /* best-effort */ }
    pool.delete(key);
  }
}

export function closeAll(): void {
  for (const [key, entry] of pool) {
    try { entry.session.close(); } catch { /* best-effort */ }
    pool.delete(key);
  }
}
