import { redirect } from "next/navigation";
import { auth, signIn, signOut, usesTestLogin } from "@/lib/auth";
import { DOCS_REPO } from "@/lib/org";
import { Logo } from "@/components/site/header";

function GithubMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="size-4" aria-hidden>
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

export default async function Login({ searchParams }: PageProps<"/admin/login">) {
  const { error } = await searchParams;
  const session = await auth();
  if (session?.member) redirect("/admin/docs");
  const denied = error === "not-member" || (session?.user && !session.member);

  async function github() {
    "use server";
    await signIn("github", { redirectTo: "/admin/docs" });
  }
  async function test(form: FormData) {
    "use server";
    await signIn("test", { user: String(form.get("user") ?? ""), redirectTo: "/admin/docs" });
  }
  async function other() {
    "use server";
    await signOut({ redirectTo: "/admin/login" });
  }

  return (
    <div className="grid flex-1 place-items-center px-5 py-16">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="site-card p-8">
          <h1 className="display d32 mb-2">Edit the docs</h1>
          <p className="mb-6 text-[var(--pencil-gray)]">
            People who can push to <b className="text-black">{DOCS_REPO}</b> on GitHub can edit and publish these pages. Agents use an API key instead.
          </p>
          {usesTestLogin ? (
            <form action={test} className="space-y-3">
              <label className="block text-[12px] font-medium" htmlFor="user">
                Test user (member or outsider)
              </label>
              <input id="user" name="user" defaultValue="member" className="w-full rounded-[6px] bg-white px-3 py-2 shadow-[inset_0_0_0_1px_var(--line)]" />
              <button type="submit" className="btn btn-primary w-full justify-center">
                Sign in (test)
              </button>
            </form>
          ) : (
            <form action={github}>
              <button type="submit" className="btn btn-primary w-full justify-center">
                <GithubMark /> Continue with GitHub
              </button>
            </form>
          )}
          {denied ? (
            <div role="alert" className="callout mt-5 !mb-0">
              <span className="callout-bar" aria-hidden />
              <div>
                <p className="!mb-1 font-medium">This account can't push to {DOCS_REPO}.</p>
                <p className="!mb-2 text-[var(--pencil-gray)]">Ask the owner to add you as a collaborator, or sign in with another account.</p>
                <form action={other}>
                  <button type="submit" className="link text-[13px]">
                    Use another account
                  </button>
                </form>
              </div>
            </div>
          ) : null}
          {error && error !== "not-member" ? (
            <p role="alert" className="mt-4 text-[13px] text-[var(--destructive)]">
              Sign-in failed. Try again.
            </p>
          ) : null}
        </div>
        <p className="mt-6 text-center text-[13px] text-[var(--pencil-gray)]">
          Reading only? The docs are public, and agents can read them over MCP without a key.
        </p>
      </div>
    </div>
  );
}
