export type Incident = {
  id: string;
  requestId?: string;
  status?: string;
  source?: string;
  cameraId?: string;
  readyForAllocation?: boolean;
  assignmentPhase?: "initial" | "retry" | string;
  requiredSkill?: string;
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
  retryEligibleAt?: string | null;
  aiDetection?: {
    label?: string;
    confidence?: number;
    evidenceSummary?: string;
  };
  allocation?: {
    status?: "processing" | "completed" | "no_candidate" | string | null;
    assignedAt?: string | null;
    fallback?: boolean;
    scoreReason?: string | null;
    topCandidates?: Array<{
      id: string;
      score: number;
      distanceMeters?: number | null;
      qualified: boolean;
      rejectedReason?: string;
    }>;
    inputSnapshot?: {
      respondersEvaluated?: number;
      requiredSkill?: string;
      severity?: string;
      confidence?: number;
      evaluatedAt?: string;
    } | null;
  };
  createdAt?: string;
  updatedAt?: string;
  summary?: string | null;
};
