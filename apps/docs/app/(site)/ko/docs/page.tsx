import { redirect } from "next/navigation";
import { firstDoc } from "@/lib/content";

export default async function KoDocsIndex() {
  const first = await firstDoc("ko");
  redirect(first ? `/ko/docs/${first}` : "/docs");
}
