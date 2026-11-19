import type { Metadata } from "next";

export const metadata: Metadata = { title: "Admin", robots: { index: false } };
export const dynamic = "force-dynamic";

export default function AdminRoot({ children }: LayoutProps<"/admin">) {
  return <div className="flex min-h-screen flex-col">{children}</div>;
}
