import NextAuth from "next-auth";
import type { Provider } from "next-auth/providers";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import { isOrgMember, RECHECK_MS } from "./org";

/**
 * E2E tests swap GitHub for a login form that takes `member` or `outsider`.
 * Only when AUTH_TEST_LOGIN=1 and never in a production deployment.
 */
const testLogin = process.env.AUTH_TEST_LOGIN === "1" && process.env.VERCEL_ENV !== "production";

const providers: Provider[] = testLogin
  ? [
      Credentials({
        id: "test",
        name: "Test login",
        credentials: { user: { label: "User" } },
        authorize: (c) => {
          const user = String(c?.user ?? "");
          if (user !== "member" && user !== "outsider") return null;
          return { id: user, name: user === "member" ? "Test Member" : "Test Outsider", email: `${user}@example.test` };
        },
      }),
    ]
  : [GitHub({ authorization: { params: { scope: "read:user user:email read:org" } } })];

declare module "next-auth" {
  interface Session {
    /** Active member of the docs organisation (re-checked hourly). */
    member: boolean;
    login: string | null;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/admin/login", error: "/admin/login" },
  callbacks: {
    async jwt({ token, account, profile, user }) {
      if (account) {
        token.login = (profile as { login?: string } | undefined)?.login ?? user?.name ?? null;
        if (account.provider === "test") {
          token.member = user?.id === "member";
        } else {
          token.accessToken = account.access_token;
          token.member = account.access_token ? await isOrgMember(account.access_token) : false;
        }
        token.checkedAt = Date.now();
        return token;
      }
      const at = typeof token.accessToken === "string" ? token.accessToken : null;
      if (at && Date.now() - Number(token.checkedAt ?? 0) > RECHECK_MS) {
        token.member = await isOrgMember(at);
        token.checkedAt = Date.now();
      }
      return token;
    },
    session({ session, token }) {
      session.member = token.member === true;
      session.login = typeof token.login === "string" ? token.login : null;
      return session;
    },
  },
});

export const usesTestLogin = testLogin;
