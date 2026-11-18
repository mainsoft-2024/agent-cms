import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "agent-cms example" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">{children}</body>
    </html>
  );
}
