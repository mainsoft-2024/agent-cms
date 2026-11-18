import Link from "next/link";
import { cms, seed } from "@/lib/cms";

export const dynamic = "force-dynamic";

export default async function Home() {
  await seed();
  const posts = await cms.list({ kind: "anonymous" }, "posts");
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-8">
      <h1 className="text-2xl font-semibold">agent-cms example</h1>
      <p>
        <Link className="underline" href="/admin">
          Open the admin
        </Link>
      </p>
      <ul className="space-y-2">
        {posts.map((p) => (
          <li key={p.slug}>
            <Link className="underline" href={`/posts/${p.slug}`}>
              {p.title}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
