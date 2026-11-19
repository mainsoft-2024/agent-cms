import { redirect } from "next/navigation";
import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { AdminFrame } from "./admin-frame";

/** Only people with push access to the docs repository get in. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/admin/login");
  if (!session.member) redirect("/admin/login?error=not-member");
  return (
    <Suspense>
      <AdminFrame user={session.login ?? session.user.name ?? "member"}>{children}</AdminFrame>
    </Suspense>
  );
}
