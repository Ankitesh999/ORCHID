export type PendingAckAction = {
  id: string;
  incidentId: string;
  responderId: string;
  createdAt: string;
};

const STORAGE_KEY = "orchid.pendingAckQueue.v1";

function safeParseQueue(raw: string | null): PendingAckAction[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item) => {
      return (
        item &&
        typeof item.id === "string" &&
        typeof item.incidentId === "string" &&
        typeof item.responderId === "string" &&
        typeof item.createdAt === "string"
      );
    }) as PendingAckAction[];
  } catch {
    return [];
  }
}

function readQueue(): PendingAckAction[] {
  if (typeof window === "undefined") {
    return [];
  }
  return safeParseQueue(window.localStorage.getItem(STORAGE_KEY));
}

function writeQueue(queue: PendingAckAction[]) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
}

export function listPendingAcks(): PendingAckAction[] {
  return readQueue();
}

export function enqueuePendingAck(incidentId: string, responderId: string): PendingAckAction {
  const entry: PendingAckAction = {
    id: `${incidentId}:${Date.now()}`,
    incidentId,
    responderId,
    createdAt: new Date().toISOString(),
  };
  const current = readQueue();
  const exists = current.some((item) => item.incidentId === incidentId && item.responderId === responderId);
  if (exists) {
    return current.find((item) => item.incidentId === incidentId && item.responderId === responderId) || entry;
  }
  const next = [...current, entry];
  writeQueue(next);
  return entry;
}

export function removePendingAck(actionId: string) {
  const current = readQueue();
  const next = current.filter((item) => item.id !== actionId);
  writeQueue(next);
}

export async function flushPendingAcks(ackFunctionUrl: string): Promise<{ flushed: number; failed: number }> {
  if (!ackFunctionUrl) {
    return { flushed: 0, failed: readQueue().length };
  }
  const queue = readQueue();
  if (!queue.length) {
    return { flushed: 0, failed: 0 };
  }

  let flushed = 0;
  let failed = 0;

  for (const item of queue) {
    try {
      const response = await fetch(ackFunctionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ incidentId: item.incidentId, responderId: item.responderId }),
      });
      if (!response.ok) {
        failed += 1;
        continue;
      }
      removePendingAck(item.id);
      flushed += 1;
    } catch {
      failed += 1;
    }
  }

  return { flushed, failed };
}