export type Incident = {
  id: string;
  requestId?: string;
  status?: string;
  source?: string;
  cameraId?: string;
  classification?: {
    provisional?: string;
    enriched?: string | null;
  };
  severity?: {
    provisional?: string;
    enriched?: string | null;
  };
  enrichmentState?: string;
  assignedResponderId?: string | null;
  assignmentAttempt?: number;
  ackDeadline?: string | null;
  acknowledgedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  summary?: string | null;
};
