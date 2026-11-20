import type { Metadata } from "next";
import { Bodoni_Moda, IBM_Plex_Sans, JetBrains_Mono, Noto_Serif_KR } from "next/font/google";
import "./globals.css";

// Teal Terminal On Paper: Bodoni Moda for the display voice (stand-in for But Head),
// IBM Plex Sans for UI and body (for Inter), JetBrains Mono for code (for Geist Mono).
// Hangul: Noto Serif KR for headings, Pretendard (CDN below) for text.
const bodoni = Bodoni_Moda({ subsets: ["latin"], axes: ["opsz"], variable: "--font-bodoni", display: "swap" });
const plexSans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans", display: "swap" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], weight: "400", variable: "--font-jetbrains-mono", display: "swap" });
const notoSerifKr = Noto_Serif_KR({ weight: "400", variable: "--font-noto-serif-kr", display: "swap", preload: false });

const siteUrl = process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "agent-cms: serverless CMS for agents and humans", template: "%s | agent-cms" },
  description: "Add a CMS to your Next.js app and Postgres. People edit in the admin screens; agents edit the same documents through MCP, the CLI and REST, or the same tools inside your own agent.",
  openGraph: { siteName: "agent-cms", type: "website" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${bodoni.variable} ${plexSans.variable} ${jetbrainsMono.variable} ${notoSerifKr.variable} h-full`}>
      <head>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css" />
      </head>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
