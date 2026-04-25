import { RespondersManagementShell } from "../../../components/responders-management-shell";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ORCHID Responders",
  description: "Manage responder accounts and field readiness.",
};

export default function RespondersPage() {
  return <RespondersManagementShell />;
}
