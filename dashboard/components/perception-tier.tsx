"use client";

import { useEffect, useRef, useState } from "react";
import {
  createCameraChannel,
  createDetectionChannel,
  createMicChannel,
  type BroadcastMessage,
  type DetectionEventMessage,
  type MicBroadcastMessage,
} from "../lib/broadcast";

type DetectionState = {
  detected: boolean;
  confidence: number;
  label: string;
  bbox?: { x: number; y: number; w: number; h: number };
  inferenceMs: number;
};

type MicState = {
  active: boolean;
  frequencyData: number[];
  volume: number;
  alert: boolean;
  lastTs: number | null;
};

function AcousticWaveform({ alert, frequencyData, active }: { alert?: boolean; frequencyData?: number[]; active?: boolean }) {
  const values = active && frequencyData?.length ? frequencyData.slice(0, 32) : Array.from({ length: 20 }, () => 0);
  return (
    <div className={`acoustic-waveform ${active ? "acoustic-waveform-live" : ""}`}>
      {values.map((value, i) => (
        <div
          key={i}
          className={`waveform-bar ${alert ? "waveform-bar-active" : ""}`}
          style={active ? { height: `${Math.max(8, (value / 255) * 100)}%` } : { animationDelay: `${i * 0.06}s` }}
        />
      ))}
    </div>
  );
}

function VitalsLine({ alert }: { alert?: boolean }) {
  const normal = "M0,30 L20,30 L25,15 L30,45 L35,10 L40,50 L45,30 L65,30 L70,15 L75,45 L80,10 L85,50 L90,30 L110,30 L115,15 L120,45 L125,10 L130,50 L135,30 L160,30";
  const spike = "M0,30 L15,30 L18,5 L21,55 L24,0 L27,60 L30,30 L50,30 L53,5 L56,55 L59,0 L62,60 L65,30 L85,30 L88,5 L91,55 L94,0 L97,60 L100,30 L120,30 L123,5 L126,55 L129,0 L132,60 L135,30 L160,30";
  return (
    <div className="vitals-feed">
      <svg className="vitals-svg" viewBox="0 0 160 60" preserveAspectRatio="none">
        <path className={`vitals-line ${alert ? "vitals-line-spike" : ""}`} d={alert ? spike : normal} />
        <circle className="vitals-dot" cx="160" cy="30" r="3" />
      </svg>
      <span className={`vitals-label ${alert ? "vitals-label-alert" : ""}`}>
        {alert ? "⚠ CRITICAL — 42 BPM" : "74 BPM — NORMAL"}
      </span>
    </div>
  );
}

function PassiveDetectionBox() {
  const [pos, setPos] = useState({ x: 30, y: 30, w: 20, h: 30 });

  useEffect(() => {
    const updatePos = () => {
      setPos({
        x: 15 + Math.random() * 50,
        y: 15 + Math.random() * 40,
        w: 15 + Math.random() * 20,
        h: 20 + Math.random() * 30,
      });
    };
    updatePos();
    const interval = setInterval(updatePos, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      className="passive-bbox"
      style={{
        left: `${pos.x}%`,
        top: `${pos.y}%`,
        width: `${pos.w}%`,
        height: `${pos.h}%`,
      }}
    >
      <span className="passive-bbox-label">AI SCANNING...</span>
    </div>
  );
}

type FeedConfig = {
  id: string;
  label: string;
  zone: string;
  type: "camera" | "acoustic" | "vitals";
  isLive?: boolean;
  alertDemo?: boolean;
};

const FEEDS: FeedConfig[] = [
  { id: "CAM-01", label: "📷 CAM-01", zone: "LOBBY-EAST", type: "camera", isLive: true },
  { id: "CAM-02", label: "📷 CAM-02", zone: "CORRIDOR-A", type: "camera" },
  { id: "CAM-03", label: "📷 CAM-03", zone: "EAST-WING", type: "camera" },
  { id: "CAM-04", label: "📷 CAM-04", zone: "EXIT-BLOCK", type: "camera" },
  { id: "MIC-01", label: "🎙 MIC-01", zone: "CORRIDOR-A", type: "acoustic" },
  { id: "MIC-02", label: "🎙 MIC-02", zone: "LOBBY", type: "acoustic" },
  { id: "VTL-01", label: "❤ VTL-01", zone: "GUEST-W12", type: "vitals" },
  { id: "VTL-02", label: "❤ VTL-02", zone: "STAFF-S04", type: "vitals" },
];

function FeedCard({ config, liveFrame, detection, mic }: {
  config: FeedConfig;
  liveFrame: string | null;
  detection: DetectionState | null;
  mic: MicState;
}) {
  const isLiveActive = config.isLive && !!liveFrame;
  const isMic01 = config.id === "MIC-01";
  const hasAlert = config.isLive ? detection?.detected : isMic01 ? mic.alert : config.alertDemo;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!isLiveActive || !liveFrame || !canvasRef.current) return;
    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
    };
    img.src = liveFrame;
  }, [liveFrame, isLiveActive]);

  return (
    <div className={`pf-card ${hasAlert ? "pf-card-alert" : ""}`}>
      <div className="pf-header">
        <div className="pf-header-left">
          {(isLiveActive || hasAlert) && <div className="pf-live-dot" />}
          <span className="pf-label">{config.label}</span>
        </div>
        <div className="pf-header-right">
          <span className="pf-zone">{config.zone}</span>
        </div>
      </div>

      <div className={
        config.type === "camera" ? "pf-camera-bg" :
        config.type === "acoustic" ? "pf-acoustic-bg" : "pf-vitals-bg"
      }>
        {config.type === "camera" && (
          <>
            {isLiveActive ? (
              <canvas ref={canvasRef} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <span className="pf-idle-text">{config.alertDemo ? "" : "NO SIGNAL"}</span>
            )}
            <div className="pf-scanlines" />
            {hasAlert && <div className="pf-alert-border" />}
            {config.isLive && detection?.detected && detection.bbox && (
              <div
                className="yolo-bbox yolo-bbox-soc"
                style={{
                  left: `${detection.bbox.x}%`,
                  top: `${detection.bbox.y}%`,
                  width: `${detection.bbox.w}%`,
                  height: `${detection.bbox.h}%`,
                }}
              >
                <span className="yolo-label">{detection.label}</span>
              </div>
            )}
            {config.alertDemo && (
              <>
                <div className="bounding-box" />
                <span className="alert-text">⚠ PERSON DOWN — AI DETECTION</span>
              </>
            )}
            {!config.isLive && !config.alertDemo && ["CAM-02", "CAM-03", "CAM-04"].includes(config.id) && (
              <PassiveDetectionBox />
            )}
          </>
        )}
        {config.type === "acoustic" && (
          isMic01 || config.alertDemo ? (
            <AcousticWaveform
              alert={isMic01 ? mic.alert : config.alertDemo}
              frequencyData={isMic01 ? mic.frequencyData : undefined}
              active={isMic01 ? mic.active : false}
            />
          ) : (
            <span className="pf-idle-text">NO SIGNAL</span>
          )
        )}
        {config.type === "vitals" && <VitalsLine alert={config.alertDemo} />}
      </div>

      <div className="pf-footer">
        {isMic01 ? (
          <>
            <span>{mic.alert ? "ALERT" : mic.active ? "LIVE" : "NO SIGNAL"}</span>
            <div className="pf-conf-track">
              <div
                className={`pf-conf-fill ${mic.alert ? "pf-conf-fill-alert" : ""}`}
                style={{ width: `${mic.active ? mic.volume : 0}%` }}
              />
            </div>
            <span className={`pf-conf-pct ${mic.alert ? "pf-conf-pct-alert" : ""}`}>{mic.active ? `${mic.volume}%` : "-"}</span>
          </>
        ) : config.isLive && detection ? (
          <>
            <span>{detection.detected ? "⚠ ALERT" : "✓ CLEAR"}</span>
            <div className="pf-conf-track">
              <div
                className={`pf-conf-fill ${detection.detected ? "pf-conf-fill-alert" : ""}`}
                style={{ width: `${detection.confidence}%` }}
              />
            </div>
            <span className={`pf-conf-pct ${detection.detected ? "pf-conf-pct-alert" : ""}`}>
              {detection.confidence}%
            </span>
          </>
        ) : config.alertDemo ? (
          <>
            <span>⚠ ALERT</span>
            <div className="pf-conf-track"><div className="pf-conf-fill pf-conf-fill-alert" style={{ width: "94%" }} /></div>
            <span className="pf-conf-pct pf-conf-pct-alert">94%</span>
          </>
        ) : (
          <>
            <span>✓ CLEAR</span>
            <div className="pf-conf-track"><div className="pf-conf-fill" style={{ width: "12%" }} /></div>
            <span className="pf-conf-pct">—</span>
          </>
        )}
      </div>
    </div>
  );
}

export function PerceptionTier() {
  const [liveFrame, setLiveFrame] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [detection, setDetection] = useState<DetectionState | null>(null);
  const [mic, setMic] = useState<MicState>({
    active: false,
    frequencyData: [],
    volume: 0,
    alert: false,
    lastTs: null,
  });

  useEffect(() => {
    const camCh = createCameraChannel();
    const detCh = createDetectionChannel();
    const micCh = createMicChannel();

    if (camCh) {
      camCh.onmessage = (ev: MessageEvent<BroadcastMessage>) => {
        if (ev.data.type === "frame") {
          setLiveFrame(ev.data.dataUrl);
          setCameraActive(true);
        } else if (ev.data.type === "status") {
          setCameraActive(ev.data.active);
          if (!ev.data.active) setLiveFrame(null);
        }
      };
    }

    if (detCh) {
      detCh.onmessage = (ev: MessageEvent<DetectionEventMessage>) => {
        setDetection({
          detected: ev.data.detected,
          confidence: ev.data.confidence,
          label: ev.data.label,
          bbox: ev.data.bbox,
          inferenceMs: ev.data.inferenceMs,
        });
      };
    }

    if (micCh) {
      micCh.onmessage = (ev: MessageEvent<MicBroadcastMessage>) => {
        const message = ev.data;
        switch (message.type) {
          case "mic_status":
            setMic((current) => ({
              ...current,
              active: message.active,
              frequencyData: message.active ? current.frequencyData : [],
              volume: message.active ? current.volume : 0,
              alert: message.active ? current.alert : false,
            }));
            break;
          case "mic_frequency":
            setMic({
              active: true,
              frequencyData: message.frequencyData,
              volume: message.volume,
              alert: message.volume >= 78,
              lastTs: message.ts,
            });
            break;
          case "mic_anomaly":
            setMic((current) => ({
              ...current,
              active: true,
              volume: message.volume,
              alert: message.detected,
              lastTs: message.ts,
            }));
            break;
        }
      };
    }

    return () => {
      camCh?.close();
      detCh?.close();
      micCh?.close();
    };
  }, []);

  return (
    <section className="card soc-panel perception-tier-section" aria-label="Perception Tier">
      <div className="pf-section-head">
        <h2>Perception Tier <span className="pf-subtitle">Edge Fusion & IoT Feeds</span></h2>
        <div className="pf-status-pills">
          <span className={`pf-pill ${cameraActive ? "pf-pill-green" : "pf-pill-red"}`}>
            {cameraActive ? "EDGE NODE LIVE" : "EDGE OFFLINE"}
          </span>
          <span className={`pf-pill ${mic.active ? "pf-pill-green" : "pf-pill-purple"}`}>{mic.active ? "MIC LIVE" : "MIC STANDBY"}</span>
          <span className="pf-pill pf-pill-purple">8 SENSORS</span>
          {(detection?.detected || mic.alert) && <span className="pf-pill pf-pill-red">ANOMALY ACTIVE</span>}
        </div>
      </div>
      <div className="perception-feeds-grid">
        {FEEDS.map((feed) => (
          <FeedCard
            key={feed.id}
            config={feed}
            liveFrame={feed.isLive ? liveFrame : null}
            detection={feed.isLive ? detection : null}
            mic={mic}
          />
        ))}
      </div>
    </section>
  );
}
