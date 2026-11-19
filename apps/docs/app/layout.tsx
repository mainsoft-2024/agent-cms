import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter, Oswald } from "next/font/google";
import "./globals.css";

// Inter for UI and body, Oswald for the display voice (stand-in for Van Condensed
// Pro Bold), IBM Plex Mono for code. Hangul falls back to Pretendard (CDN below).
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const oswald = Oswald({ subsets: ["latin"], weight: "700", variable: "--font-oswald", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap" });

const siteUrl = process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "agent-cms: serverless CMS for agents and humans", template: "%s | agent-cms" },
  description: "Add a CMS to your Next.js app and Postgres. People edit in the admin screens; agents edit the same documents through MCP, AI SDK tools, the CLI and REST.",
  openGraph: { siteName: "agent-cms", type: "website" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${oswald.variable} ${plexMono.variable} h-full`}>
      <head>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css" />
      </head>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
