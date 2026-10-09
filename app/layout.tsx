import type { Metadata } from "next";

import "./globals.css";

const programmeName = process.env.NEXT_PUBLIC_PROGRAMME_NAME?.trim() || "Youth Live Saturday";

export const metadata: Metadata = {
  title: {
    default: "Vox",
    template: "%s | Vox",
  },
  description: "Vox is a simple live audio room for church youth programmes with real-time comments and reactions.",
  applicationName: "Vox",
  keywords: ["Vox", "Live audio", "Church youth programme", "LiveKit"],
  openGraph: {
    title: "Vox",
    description: `Tune in to ${programmeName} on Vox.`,
    siteName: "Vox",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Vox",
    description: `Tune in to ${programmeName} on Vox.`,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
