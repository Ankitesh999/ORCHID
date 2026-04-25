/**
 * BroadcastChannel wrapper for streaming camera frames
 * from the Inject page to the SOC dashboard (same browser).
 */

export const CAMERA_CHANNEL_NAME = "orchid-camera-feed";
export const DETECTION_CHANNEL_NAME = "orchid-detection-events";
export const MIC_CHANNEL_NAME = "orchid-mic-feed";

export type CameraFrameMessage = {
  type: "frame";
  /** Base64 data URL of the JPEG frame */
  dataUrl: string;
  /** Timestamp of the frame */
  ts: number;
  /** Camera ID label */
  cameraId: string;
};

export type DetectionEventMessage = {
  type: "detection";
  /** Whether an anomaly was detected */
  detected: boolean;
  /** Confidence percentage 0-100 */
  confidence: number;
  /** Detection label */
  label: string;
  /** Bounding box as percentage of frame dimensions */
  bbox?: { x: number; y: number; w: number; h: number };
  /** Inference time in ms */
  inferenceMs: number;
  ts: number;
};

export type CameraStatusMessage = {
  type: "status";
  active: boolean;
  cameraId: string;
};

export type MicFrequencyMessage = {
  type: "mic_frequency";
  frequencyData: number[];
  volume: number;
  ts: number;
  micId: string;
};

export type MicStatusMessage = {
  type: "mic_status";
  active: boolean;
  micId: string;
};

export type MicAnomalyMessage = {
  type: "mic_anomaly";
  detected: boolean;
  volume: number;
  confidence: number;
  label: string;
  ts: number;
  micId: string;
};

export type BroadcastMessage = CameraFrameMessage | DetectionEventMessage | CameraStatusMessage;
export type MicBroadcastMessage = MicFrequencyMessage | MicStatusMessage | MicAnomalyMessage;

/**
 * Create a BroadcastChannel for camera frames.
 * Returns null if BroadcastChannel is not supported.
 */
export function createCameraChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  return new BroadcastChannel(CAMERA_CHANNEL_NAME);
}

export function createDetectionChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  return new BroadcastChannel(DETECTION_CHANNEL_NAME);
}

export function createMicChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  return new BroadcastChannel(MIC_CHANNEL_NAME);
}
