# ORCHID System — Proposed Improvements

## Summary

After auditing the full codebase and incorporating user feedback, here are the core problems and the proposed solutions:

1. **Mock crisis script is impractical** — running a terminal Python command to simulate a crisis is not demo-friendly.
2. **Live Perception Tier is a placeholder** — 4 grey boxes labelled "Feed 1–4" with zero interaction destroys immersion.
3. **Responder Simulation lacks WOW** — drag-and-drop exists but the map is a featureless white board; no movement animation, no real-time feel.

---

## User Review Required

> [!IMPORTANT]
> Based on the latest feedback, we are implementing:
>
> 1. **Separate `/inject` Page** — The Crisis Injection Panel will be a dedicated page (`/inject`) instead of an inline dashboard element.
> 2. **Real Data-Driven Perception** — The Perception Tier feeds will spike based on **real Firestore incident data**, making the demo authentic.
> 3. **Triple Sensor Fusion** — The injector will expose **Camera, Acoustic, and Vitals** sensors to demonstrate the multi-sensor fusion capability.

---

## Proposed Changes

### 1. Dedicated `/inject` Crisis Injection Page

**Problem:** CLI-based injection is invisible. Inline dashboard injection can clutter the main SOC view.

**Solution:** Build a dedicated **"⚡ ORCHID Crisis Injector"** at `/inject`.

- **Sensor type selector**: Camera 📷 / Acoustic 🎙️ / Vitals ❤️ (Pill buttons with brand colors)
- **Incident type selector**: Medical Emergency 🩺 / Fire 🔥 / Structural Threat 🏗️ / Intrusion 🚨 / Chemical Spill ☢️
- **Severity override**: Manual slider to force Critical/High/Medium/Low.
- **Fire Event button**: Directly calls `NEXT_PUBLIC_INGEST_FUNCTION_URL`.
- **Live Response Log**: A terminal-style log showing the raw JSON response and incident ID from the cloud function.

---

### 2. Live Perception Tier — Firestore-Driven Feed Simulator

**Problem:** Static grey boxes don't show the "brain" of the system.

**Solution:** Replace the static grid in the SOC Dashboard with a **dynamic perception panel** driven by live Firestore data.

#### [MODIFY] `dashboard/components/dashboard-shell.tsx`

- **Real-Time Data Binding**: The `activeIncident` from Firestore will drive the UI.
- **Feed Logic**:
  - **Idle State**: Feeds show subtle "scanline" noise and confidence meters fluctuating between 10–35%.
  - **Active State**: When an incident is detected:
    - **Feed 1 (Camera)**: If `sensorType === 'camera'`, show **red bounding box** + confidence spike (85-99%).
    - **Feed 2 (Acoustic)**: If `sensorType === 'acoustic'`, show **audio waveform animation** + "DISTRESS DETECTED".
    - **Feed 3 (Vitals)**: If `sensorType === 'vitals'`, show **ECG/Heart-rate spike animation**.
- **Visuals**: Pulsing "LIVE" indicators and CSS-based noise overlays.

---

### 3. Responder Simulation — Tactical Operations Map

**Problem:** The simulation board is a white `div`. No sense of geography.

**Solution:** Upgrade the simulation board to a **Tactical Operations Map**.

#### [MODIFY] `dashboard/components/dashboard-shell.tsx`
#### [MODIFY] `dashboard/app/globals.css`

- **Dark Grid Background**: SVG-based architectural outline of the campus.
- **Tactical Pins**:
  - **Responders**: Pulsing green shadows for available, red for assigned.
  - **Incidents**: Blinking red crosshair at the `location` lat/lng provided by Firestore.
- **Animations**: Smooth 500ms transitions for all marker movements (GPS tracking feel).

---

### 4. Responder Shell — Field Interface Upgrade

**Problem:** The responder's task card lacks urgency.

**Solution:** High-fidelity upgrade to the mobile-view responder interface.

#### [MODIFY] `dashboard/components/responder-shell.tsx`

- **ACK Countdown Ring**: SVG circular timer ticking down to `ackDeadline`.
- **Tactical Brief Card**: Structured data (Severity, Evidence, Actions) instead of flat text.
- **Mesh Mode Indicator**: Amber banner when `isOnline === false`.

---

## Implementation Order

1. **Styling Foundation**: Update `globals.css` with tactical map and feed card styles.
2. **Injector Page**: Finalize `/inject` page logic and styling (Triple sensor fusion).
3. **SOC Dashboard**: Implement Firestore-driven Perception Tier and Tactical Map.
4. **Responder Interface**: Add countdown timers and structured brief cards.

## Verification Plan

### Manual Verification
1. Open `/inject` in one tab and the SOC Dashboard in another.
2. Fire a "Vitals" incident from `/inject`.
3. Confirm SOC Dashboard Perception Tier Feed 3 (Vitals) spikes and shows heart-rate animation.
4. Confirm Tactical Map shows a blinking red crosshair at the event location.
5. Confirm Responder Shell shows the task with a ticking countdown timer.
