import Link from "next/link";
import { auth, signOut } from "@/lib/auth";
import { Logo } from "@/components/site/header";

// A page, not a GET route: Next prefetches links, and a GET that signs out
// would end the session as soon as the sidebar shows the link.
export default async function Logout() {
  const session = await auth();

  async function out() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <div className="grid flex-1 place-items-center px-5 py-16">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="site-card p-8">
          <h1 className="display d32 mb-2">Sign out</h1>
          <p className="mb-6 text-[var(--pencil-gray)]">
            {session?.user ? `Signed in as ${session.login ?? session.user.name ?? "a member"}.` : "You are not signed in."}
          </p>
          {session?.user ? (
            <form action={out} className="flex gap-3">
              <button type="submit" className="btn btn-primary flex-1 justify-center">
                Sign out
              </button>
              <Link href="/admin/docs" className="btn flex-1 justify-center">
                Stay
              </Link>
            </form>
          ) : (
            <Link href="/" className="btn btn-primary w-full justify-center">
              Back to the docs
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
