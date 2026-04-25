export type Incident = {
  id: string;
  requestId?: string;
  status?: string;
  source?: string;
  sourceType?: "camera_capture" | "edge_node" | "manual" | string;
  aiState?: "classifying" | "completed" | "failed" | "manual_triage" | string;
  triageRequired?: boolean;
  triage?: {
    required?: boolean;
    reason?: string;
    safeError?: string;
    resolvedAt?: string;
    resolvedBy?: string | null;
  };
  audit?: {
    rawImagePersisted?: boolean;
    ingestedAt?: string;
    classificationMode?: "live_ai" | "manual_triage" | string;
    privacyMode?: string;
    triagedAt?: string;
  };
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
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  resolution?: {
    distanceMeters?: number;
    location?: {
      lat?: number;
      lng?: number;
    };
  };
  retryEligibleAt?: string | null;
  aiDetection?: {
    label?: string;
    confidence?: number;
    evidenceSummary?: string;
  };
  location?: {
    lat?: number;
    lng?: number;
  };
  tacticalReasoning?: {
    safeApproach?: string;
    hazards?: string[];
    victimCount?: number;
    recommendedEquipment?: string[];
    priorityActions?: string[];
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
