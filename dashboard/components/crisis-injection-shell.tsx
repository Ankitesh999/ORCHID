"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, User } from "firebase/auth";

import { auth } from "../lib/firebase";
import {
  createCameraChannel,
  createDetectionChannel,
  createMicChannel,
  type CameraFrameMessage,
  type DetectionEventMessage,
  type CameraStatusMessage,
  type MicAnomalyMessage,
  type MicFrequencyMessage,
  type MicStatusMessage,
} from "../lib/broadcast";
import { randomPointNearDemoCampus } from "../lib/geo";

const INGEST_URL = process.env.NEXT_PUBLIC_INGEST_FUNCTION_URL ?? "";

type LogEntry = {
  id: string;
  ts: string;
  type: "info" | "success" | "error" | "send" | "detect";
  msg: string;
};

type DetectionResult = {
  detected: boolean;
  confidence: number;
  label: string;
  bbox: { x: number; y: number; w: number; h: number };
  inferenceMs: number;
};

// Motion detection tuning
const MOTION_THRESHOLD = 30; // pixel diff threshold
const MOTION_PIXEL_RATIO = 0.02; // 2% of pixels must change
const DETECTION_FPS = 2;
const AUTO_COOLDOWN_MS = 8000; // min time between auto-captures
const MIC_SAMPLE_MS = 100;
const MIC_ANOMALY_THRESHOLD = 78;
const MIC_AUTO_COOLDOWN_MS = 15000;

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function stripDataUrlPrefix(value: string) {
  const marker = "base64,";
  const index = value.indexOf(marker);
  return index >= 0 ? value.slice(index + marker.length) : value;
}

export function CrisisInjectionShell() {
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [streamReady, setStreamReady] = useState(false);
  const [firing, setFiring] = useState(false);
  const [shotCount, setShotCount] = useState(0);
  const [lastFrame, setLastFrame] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [autoDetect, setAutoDetect] = useState(false);
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [autoCaptures, setAutoCaptures] = useState(0);
  const [micActive, setMicActive] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [micVolume, setMicVolume] = useState(0);
  const [micFrequencyData, setMicFrequencyData] = useState<number[]>([]);
  const [micAnomaly, setMicAnomaly] = useState(false);
  const [micAutoCaptures, setMicAutoCaptures] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevFrameRef = useRef<ImageData | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const autoDetectRef = useRef(false);
  const lastAutoCaptureRef = useRef(0);
  const animFrameRef = useRef<number | null>(null);
  const cameraChannelRef = useRef<BroadcastChannel | null>(null);
  const detectionChannelRef = useRef<BroadcastChannel | null>(null);
  const micChannelRef = useRef<BroadcastChannel | null>(null);
  const broadcastCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastMicIncidentRef = useRef(0);

  // Keep autoDetect ref in sync
  useEffect(() => {
    autoDetectRef.current = autoDetect;
  }, [autoDetect]);

  useEffect(() => {
    return onAuthStateChanged(auth, (next) => {
      setUser(next);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  // Initialize BroadcastChannels
  useEffect(() => {
    cameraChannelRef.current = createCameraChannel();
    detectionChannelRef.current = createDetectionChannel();
    micChannelRef.current = createMicChannel();
    return () => {
      // Notify SOC that camera is offline
      cameraChannelRef.current?.postMessage({ type: "status", active: false, cameraId: "browser-camera-01" } satisfies CameraStatusMessage);
      micChannelRef.current?.postMessage({ type: "mic_status", active: false, micId: "MIC-01" } satisfies MicStatusMessage);
      cameraChannelRef.current?.close();
      detectionChannelRef.current?.close();
      micChannelRef.current?.close();
    };
  }, []);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      audioContextRef.current?.close().catch(() => undefined);
      if (micIntervalRef.current) clearInterval(micIntervalRef.current);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  function appendLog(type: LogEntry["type"], msg: string) {
    setLog((prev) => [
      ...prev,
      { id: makeId(), ts: new Date().toLocaleTimeString("en-US", { hour12: false }), type, msg },
    ]);
  }

  async function onSignIn(event: React.FormEvent) {
    event.preventDefault();
    setAuthError(null);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Login failed.");
    }
  }

  async function startCamera() {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setStreamReady(true);
      appendLog("success", "Camera stream ready. YOLO auto-detection available.");

      // Notify SOC dashboard
      cameraChannelRef.current?.postMessage({
        type: "status",
        active: true,
        cameraId: "browser-camera-01",
      } satisfies CameraStatusMessage);

      // Start broadcasting frames to SOC
      startFrameBroadcast();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Camera permission denied.";
      setCameraError(message);
      appendLog("error", `Camera unavailable: ${message}`);
    }
  }

  async function startMicrophone() {
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      micStreamRef.current = stream;

      const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) throw new Error("Web Audio API is unavailable.");

      await audioContextRef.current?.close().catch(() => undefined);
      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);

      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      setMicActive(true);
      appendLog("success", "Microphone stream ready. Acoustic anomaly detection active.");
      micChannelRef.current?.postMessage({ type: "mic_status", active: true, micId: "MIC-01" } satisfies MicStatusMessage);

      if (micIntervalRef.current) clearInterval(micIntervalRef.current);
      micIntervalRef.current = setInterval(sampleMicrophone, MIC_SAMPLE_MS);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Microphone permission denied.";
      setMicError(message);
      appendLog("error", `Microphone unavailable: ${message}`);
    }
  }

  function stopMicrophone() {
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
    if (micIntervalRef.current) clearInterval(micIntervalRef.current);
    micIntervalRef.current = null;
    audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    analyserRef.current = null;
    setMicActive(false);
    setMicVolume(0);
    setMicAnomaly(false);
    setMicFrequencyData([]);
    micChannelRef.current?.postMessage({ type: "mic_status", active: false, micId: "MIC-01" } satisfies MicStatusMessage);
    appendLog("info", "Microphone stream stopped.");
  }

  function sampleMicrophone() {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bins);
    const frequencyData = Array.from(bins);
    const rms = Math.sqrt(frequencyData.reduce((sum, value) => sum + value * value, 0) / Math.max(1, frequencyData.length));
    const volume = Math.min(100, Math.round((rms / 255) * 140));
    const anomaly = volume >= MIC_ANOMALY_THRESHOLD;
    const now = Date.now();
    const confidence = Math.min(99, Math.max(55, Math.round(volume * 1.05)));

    setMicFrequencyData(frequencyData);
    setMicVolume(volume);
    setMicAnomaly(anomaly);
    micChannelRef.current?.postMessage({
      type: "mic_frequency",
      frequencyData,
      volume,
      ts: now,
      micId: "MIC-01",
    } satisfies MicFrequencyMessage);

    if (anomaly) {
      micChannelRef.current?.postMessage({
        type: "mic_anomaly",
        detected: true,
        volume,
        confidence,
        label: "ACOUSTIC ANOMALY",
        ts: now,
        micId: "MIC-01",
      } satisfies MicAnomalyMessage);
    }

    if (anomaly && INGEST_URL && now - lastMicIncidentRef.current > MIC_AUTO_COOLDOWN_MS) {
      lastMicIncidentRef.current = now;
      appendLog("detect", `MIC AUTO-DETECT: volume ${volume} - submitting acoustic incident...`);
      void autoFireMicIncident(volume, confidence);
    }
  }

  function startFrameBroadcast() {
    if (!broadcastCanvasRef.current) {
      broadcastCanvasRef.current = document.createElement("canvas");
    }

    let lastBroadcast = 0;
    const BROADCAST_INTERVAL = 200; // 5 FPS broadcast to SOC

    function broadcastLoop() {
      animFrameRef.current = requestAnimationFrame(broadcastLoop);
      const now = Date.now();
      if (now - lastBroadcast < BROADCAST_INTERVAL) return;
      lastBroadcast = now;

      const video = videoRef.current;
      const canvas = broadcastCanvasRef.current;
      if (!video || !canvas || video.readyState < 2) return;

      // Downscale for broadcast
      const w = 320;
      const h = Math.round((video.videoHeight / video.videoWidth) * w) || 180;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.5);

      cameraChannelRef.current?.postMessage({
        type: "frame",
        dataUrl,
        ts: now,
        cameraId: "browser-camera-01",
      } satisfies CameraFrameMessage);
    }

    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    broadcastLoop();
  }

  const analyzeFrame = useCallback((): DetectionResult | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return null;

    const startTime = performance.now();

    const w = 320;
    const h = Math.round((video.videoHeight / video.videoWidth) * w) || 180;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, w, h);
    const currentFrame = ctx.getImageData(0, 0, w, h);

    if (!prevFrameRef.current) {
      prevFrameRef.current = currentFrame;
      return null;
    }

    const prev = prevFrameRef.current.data;
    const curr = currentFrame.data;
    const totalPixels = w * h;
    let changedPixels = 0;
    let minX = w, minY = h, maxX = 0, maxY = 0;

    for (let i = 0; i < curr.length; i += 4) {
      const dr = Math.abs(curr[i] - prev[i]);
      const dg = Math.abs(curr[i + 1] - prev[i + 1]);
      const db = Math.abs(curr[i + 2] - prev[i + 2]);
      const diff = (dr + dg + db) / 3;

      if (diff > MOTION_THRESHOLD) {
        changedPixels++;
        const pixelIndex = i / 4;
        const px = pixelIndex % w;
        const py = Math.floor(pixelIndex / w);
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }

    prevFrameRef.current = currentFrame;
    const ratio = changedPixels / totalPixels;
    const inferenceMs = performance.now() - startTime;

    if (ratio > MOTION_PIXEL_RATIO && maxX > minX && maxY > minY) {
      const confidence = Math.min(98, Math.round(ratio * 500));
      const result: DetectionResult = {
        detected: true,
        confidence,
        label: confidence > 70 ? "ANOMALY — PERSON DISTRESS" : "MOTION DETECTED",
        bbox: {
          x: (minX / w) * 100,
          y: (minY / h) * 100,
          w: ((maxX - minX) / w) * 100,
          h: ((maxY - minY) / h) * 100,
        },
        inferenceMs,
      };

      // Broadcast detection event to SOC
      detectionChannelRef.current?.postMessage({
        type: "detection",
        detected: true,
        confidence: result.confidence,
        label: result.label,
        bbox: result.bbox,
        inferenceMs: result.inferenceMs,
        ts: Date.now(),
      } satisfies DetectionEventMessage);

      return result;
    }

    // No anomaly — broadcast idle state
    detectionChannelRef.current?.postMessage({
      type: "detection",
      detected: false,
      confidence: 0,
      label: "NORMAL",
      inferenceMs,
      ts: Date.now(),
    } satisfies DetectionEventMessage);

    return { detected: false, confidence: 0, label: "NORMAL", bbox: { x: 0, y: 0, w: 0, h: 0 }, inferenceMs };
  }, []);

  // Auto-detection loop
  useEffect(() => {
    if (!autoDetect || !streamReady) return;

    appendLog("info", "YOLO auto-detection ENGAGED — scanning at 2 FPS.");
    prevFrameRef.current = null;

    const interval = setInterval(async () => {
      if (!autoDetectRef.current) return;

      const result = analyzeFrame();
      setDetection(result);

      if (
        result?.detected &&
        result.confidence > 50 &&
        Date.now() - lastAutoCaptureRef.current > AUTO_COOLDOWN_MS &&
        !firing
      ) {
        lastAutoCaptureRef.current = Date.now();
        appendLog("detect", `AUTO-DETECT: ${result.label} (${result.confidence}%) — Auto-submitting...`);
        await autoFireEvent();
      }
    }, 1000 / DETECTION_FPS);

    return () => {
      clearInterval(interval);
      if (!autoDetectRef.current) {
        setDetection(null);
        appendLog("info", "Auto-detection DISENGAGED.");
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDetect, streamReady]);

  function captureFrame() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) {
      throw new Error("Camera frame is not ready yet.");
    }
    const width = video.videoWidth || 960;
    const height = video.videoHeight || 540;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not access capture canvas.");
    }
    ctx.drawImage(video, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
    setLastFrame(dataUrl);
    return dataUrl;
  }

  async function autoFireEvent() {
    if (!INGEST_URL) return;
    setFiring(true);
    try {
      const frame = captureFrame();
      const requestId = `yolo-auto-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 10)}`;
      const location = randomPointNearDemoCampus();
      const payload = {
        requestId,
        cameraId: "browser-camera-01",
        timestamp: isoNow(),
        imageBase64: stripDataUrlPrefix(frame),
        imageMimeType: "image/jpeg",
        location,
      };

      appendLog("send", `AUTO-POST ${INGEST_URL.slice(0, 56)}...`);
      appendLog("info", `requestId=${requestId} mode=auto_detect`);

      const response = await fetch(INGEST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        appendLog("error", `HTTP ${response.status}: ${data.message || data.error || "Unknown error"}`);
        return;
      }

      if (data.triageRequired) {
        appendLog("error", "AI classification needs manual triage in SOC console.");
      } else {
        appendLog("success", `Incident accepted: ${data.classification || requestId}`);
        appendLog("info", `severity=${data.severity || "pending"} confidence=${data.confidence ?? "pending"}`);
      }
      setShotCount((count) => count + 1);
      setAutoCaptures((count) => count + 1);
    } catch (err) {
      appendLog("error", err instanceof Error ? err.message : "Auto-capture failed.");
    } finally {
      setFiring(false);
    }
  }

  async function autoFireMicIncident(volume: number, confidence: number) {
    if (!INGEST_URL) return;
    try {
      const requestId = `mic-auto-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 10)}`;
      const location = randomPointNearDemoCampus();
      const payload = {
        requestId,
        cameraId: "MIC-01",
        source: "browser_microphone",
        sourceType: "microphone",
        timestamp: isoNow(),
        location,
        volume,
        confidence: confidence / 100,
      };

      appendLog("send", `MIC POST ${INGEST_URL.slice(0, 56)}...`);
      const response = await fetch(INGEST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        appendLog("error", `MIC HTTP ${response.status}: ${data.message || data.error || "Unknown error"}`);
        return;
      }
      appendLog("success", `Acoustic incident accepted: ${data.classification || requestId}`);
      setShotCount((count) => count + 1);
      setMicAutoCaptures((count) => count + 1);
    } catch (err) {
      appendLog("error", err instanceof Error ? err.message : "Mic auto-submit failed.");
    }
  }

  async function fireEvent() {
    if (!INGEST_URL) {
      appendLog("error", "NEXT_PUBLIC_INGEST_FUNCTION_URL is not configured.");
      return;
    }
    setFiring(true);
    try {
      const frame = captureFrame();
      const requestId = `cam-browser-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 10)}`;
      const location = randomPointNearDemoCampus();
      const payload = {
        requestId,
        cameraId: "browser-camera-01",
        timestamp: isoNow(),
        imageBase64: stripDataUrlPrefix(frame),
        imageMimeType: "image/jpeg",
        location,
      };

      appendLog("send", `POST ${INGEST_URL.slice(0, 56)}...`);
      appendLog("info", `requestId=${requestId} cameraId=${payload.cameraId}`);
      appendLog("info", "Sending live frame for AI classification. No simulated label is included.");

      const response = await fetch(INGEST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        appendLog("error", `HTTP ${response.status}: ${data.message || data.error || "Unknown error"}`);
        return;
      }

      if (data.triageRequired) {
        appendLog("error", "Live AI classification failed. Incident is awaiting manual triage in the SOC console.");
      } else {
        appendLog("success", `Incident accepted: ${data.classification || requestId}`);
        appendLog("info", `severity=${data.severity || "pending"} confidence=${data.confidence ?? "pending"}`);
      }
      setShotCount((count) => count + 1);
    } catch (err) {
      appendLog("error", err instanceof Error ? err.message : "Capture failed.");
    } finally {
      setFiring(false);
    }
  }

  if (loading) {
    return (
      <main className="inject-shell">
        <div className="inject-loading">
          <div className="inject-spinner" />
          <p>Initialising ORCHID intake...</p>
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="inject-shell">
        <header className="inject-topbar">
          <div className="inject-topbar-brand">
            <div>
              <h1>ORCHID Live Intake</h1>
              <p>Admin camera capture for live AI classification</p>
            </div>
          </div>
          <a href="/" className="inject-nav-link">SOC Dashboard</a>
        </header>
        <section className="card inject-auth-card">
          <h2>Admin Sign In</h2>
          <p className="inject-section-sub">Sign in with an admin account to capture and submit live incidents.</p>
          <form onSubmit={onSignIn}>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <button type="submit">Sign In</button>
          </form>
          {authError && <p className="error">{authError}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="inject-shell">
      <header className="inject-topbar">
        <div className="inject-topbar-brand">
          <div>
            <h1>ORCHID Live Intake</h1>
            <p>Automated YOLO anomaly detection with live AI classification pipeline.</p>
          </div>
        </div>
        <div className="inject-topbar-right">
          {shotCount > 0 && <span className="inject-shot-badge">{shotCount} submitted</span>}
          {autoCaptures > 0 && <span className="inject-auto-badge">{autoCaptures} auto</span>}
          {micAutoCaptures > 0 && <span className="inject-auto-badge">{micAutoCaptures} mic</span>}
          <span className={`mic-status-pill ${micActive ? "mic-status-live" : ""}`}>{micActive ? "MIC LIVE" : "MIC OFF"}</span>
          <span className="inject-user">{user.email}</span>
          <button className="button-subtle" onClick={() => signOut(auth)}>Sign Out</button>
          <a href="/" className="inject-nav-link">SOC Dashboard</a>
        </div>
      </header>

      <div className="inject-layout live-intake-layout">
        <section className="card live-capture-card">
          <div className="inject-section-title">
            <span className="inject-section-num">01</span>
            Live Camera Feed — Edge YOLO Node
          </div>
          <p className="inject-section-sub">
            {autoDetect
              ? "Auto-detect ACTIVE — anomalies trigger automatic capture and submission to the AI classification pipeline."
              : "Enable auto-detect for continuous YOLO-based anomaly scanning, or capture manually."}
          </p>

          <div className="camera-frame">
            <video ref={videoRef} playsInline muted aria-label="Live camera preview" />
            {!streamReady && <div className="camera-placeholder">Camera stream inactive</div>}

            {/* Detection overlay */}
            {detection?.detected && streamReady && (
              <div className="yolo-overlay">
                <div
                  className="yolo-bbox"
                  style={{
                    left: `${detection.bbox.x}%`,
                    top: `${detection.bbox.y}%`,
                    width: `${detection.bbox.w}%`,
                    height: `${detection.bbox.h}%`,
                  }}
                >
                  <span className="yolo-label">{detection.label}</span>
                  <span className="yolo-conf">{detection.confidence}%</span>
                </div>
                <div className="yolo-alert-border" />
              </div>
            )}

            {/* Detection HUD */}
            {streamReady && detection && (
              <div className="yolo-hud">
                <span className={`yolo-hud-status ${detection.detected ? "yolo-hud-alert" : ""}`}>
                  {detection.detected ? "⚠ ANOMALY" : "✓ NORMAL"}
                </span>
                <span className="yolo-hud-fps">
                  {detection.inferenceMs.toFixed(1)}ms
                </span>
                {autoDetect && <span className="yolo-hud-mode">AUTO</span>}
              </div>
            )}
          </div>

          <canvas ref={canvasRef} hidden />
          {cameraError && <p className="error inline">{cameraError}</p>}

          <div className="live-capture-actions">
            <button type="button" className="button-subtle" onClick={startCamera}>
              {streamReady ? "Restart Camera" : "Start Camera"}
            </button>

            <button
              type="button"
              className={`yolo-toggle-btn ${autoDetect ? "yolo-toggle-active" : ""}`}
              onClick={() => setAutoDetect((prev) => !prev)}
              disabled={!streamReady}
            >
              {autoDetect ? "⏹ Stop Auto-Detect" : "▶ Enable YOLO Auto-Detect"}
            </button>

            <button type="button" onClick={fireEvent} disabled={!streamReady || firing || !INGEST_URL}>
              {firing ? "Classifying..." : "Manual Capture"}
            </button>
          </div>

          {!INGEST_URL && (
            <p className="inject-url-warning">
              Set NEXT_PUBLIC_INGEST_FUNCTION_URL in .env.local to enable live intake.
            </p>
          )}
          {lastFrame && (
            <div className="last-frame-preview">
              <span>Last submitted frame</span>
              <img src={lastFrame} alt="Last submitted incident frame preview" />
            </div>
          )}

          <section className={`mic-capture-panel ${micAnomaly ? "mic-capture-alert" : ""}`}>
            <div className="inject-section-title">
              <span className="inject-section-num">02</span>
              Live Microphone Feed - Acoustic Node
            </div>
            <p className="inject-section-sub">
              {micActive
                ? "Streaming frequency features to SOC. Loud acoustic anomalies auto-submit incidents with cooldown protection."
                : "Start the microphone to stream acoustic features and detect loud anomalies."}
            </p>
            <div className="mic-meter-row">
              <div className="mic-spectrum" aria-label="Microphone frequency spectrum">
                {(micFrequencyData.length ? micFrequencyData.slice(0, 32) : Array.from({ length: 32 }, () => 0)).map((value, index) => (
                  <span
                    key={`${index}-${value}`}
                    style={{ height: `${Math.max(4, (value / 255) * 100)}%` }}
                    className={micAnomaly ? "mic-bar-alert" : ""}
                  />
                ))}
              </div>
              <div className="mic-volume-readout">
                <strong>{micVolume}</strong>
                <span>volume</span>
              </div>
            </div>
            {micError && <p className="error inline">{micError}</p>}
            <div className="live-capture-actions">
              <button type="button" className="button-subtle" onClick={micActive ? stopMicrophone : startMicrophone}>
                {micActive ? "Stop Microphone" : "Start Microphone"}
              </button>
              <span className={`mic-anomaly-label ${micAnomaly ? "mic-anomaly-active" : ""}`}>
                {micAnomaly ? "ACOUSTIC ALERT" : "CLEAR"}
              </span>
            </div>
          </section>
        </section>

        <section className="inject-log-panel">
          <div className="inject-log-header">
            <div>
              <h3>Intake Log</h3>
              <p>Function responses, YOLO detections, and AI classification state</p>
            </div>
            <button className="button-subtle" onClick={() => setLog([])}>Clear</button>
          </div>
          <div className="inject-log-terminal" role="log" aria-live="polite">
            {log.length === 0 ? (
              <div className="inject-log-empty">
                <span className="inject-log-cursor">_</span>
                <span>Awaiting camera capture or auto-detection.</span>
              </div>
            ) : (
              log.map((entry) => (
                <div key={entry.id} className={`inject-log-line inject-log-${entry.type}`}>
                  <span className="inject-log-ts">{entry.ts}</span>
                  <span className="inject-log-msg">{entry.msg}</span>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
          <div className="card inject-legend-card">
            <h4 className="inject-legend-title">YOLO Edge Detection Policy</h4>
            <div className="inject-legend-grid">
              <div className="inject-legend-item">
                <span className="inject-legend-dot" style={{ background: "var(--success)" }} />
                <div>
                  <div className="inject-legend-name">Frame-differencing motion detection</div>
                  <div className="inject-legend-desc">Analyzes pixel delta between consecutive frames at 2 FPS to detect anomalous motion.</div>
                </div>
              </div>
              <div className="inject-legend-item">
                <span className="inject-legend-dot" style={{ background: "var(--danger)" }} />
                <div>
                  <div className="inject-legend-name">Auto-capture on threshold breach</div>
                  <div className="inject-legend-desc">When confidence exceeds 50%, auto-captures and submits to the cloud ingest function.</div>
                </div>
              </div>
              <div className="inject-legend-item">
                <span className="inject-legend-dot" style={{ background: "var(--accent)" }} />
                <div>
                  <div className="inject-legend-name">Live feed broadcast to SOC</div>
                  <div className="inject-legend-desc">Camera frames are streamed in real-time to the SOC dashboard Perception Tier at 5 FPS.</div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
