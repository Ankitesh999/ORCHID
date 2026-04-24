import "./globals.css";
import "./orchid-updates.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ORCHID SOC Dashboard",
  description: "Realtime incident coordination dashboard"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
