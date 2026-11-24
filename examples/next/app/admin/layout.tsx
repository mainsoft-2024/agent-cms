import { Suspense, type ReactNode } from "react";
import "../cms-fonts.css";
import { AdminFrame } from "./admin-frame";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    // cms-root: the admin fonts (cms-fonts.css) also on the sign-in pages, which have no shell.
    <div className="cms-root">
      <Suspense>
        <AdminFrame>{children}</AdminFrame>
      </Suspense>
    </div>
  );
}
