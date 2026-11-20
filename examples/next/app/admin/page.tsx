import { redirect } from "next/navigation";

// The dashboard is the admin's first screen.
export default function AdminHome() {
  redirect("/admin/dashboard");
}
