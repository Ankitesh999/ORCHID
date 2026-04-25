import { CrisisInjectionShell } from "../../components/crisis-injection-shell";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ORCHID Live Intake",
  description: "Capture a browser camera frame and submit it for live AI incident classification.",
};

export default function InjectPage() {
  return <CrisisInjectionShell />;
}
