import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Thesma — S0 backend foundation",
  description: "Autonomous market for verified business outcomes. Backend-first slice S0.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>{children}</body>
    </html>
  );
}
