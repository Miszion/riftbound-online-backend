import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Riftbound Replay Viewer",
  description: "Frame-by-frame JSONL replay viewer for Riftbound self-play matches.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
