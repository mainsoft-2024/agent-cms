import { Suspense, type ReactNode } from "react";
import { AdminFrame } from "./admin-frame";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense>
      <AdminFrame>{children}</AdminFrame>
    </Suspense>
  );
}
