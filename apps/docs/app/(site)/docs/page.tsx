import { redirect } from "next/navigation";
import { firstDoc } from "@/lib/content";

export default async function DocsIndex() {
  const first = await firstDoc("en");
  redirect(first ? `/docs/${first}` : "/");
}
