import { CrisisInjectionShell } from "../../components/crisis-injection-shell";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ORCHID Crisis Injector — Sensor Fusion Event Simulator",
  description: "Fire simulated crisis events from camera, acoustic, and vitals sensors directly into the ORCHID Firestore incident pipeline.",
};

export default function InjectPage() {
  return <CrisisInjectionShell />;
}
