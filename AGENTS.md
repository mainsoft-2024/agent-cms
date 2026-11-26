# agent-cms

The open-source engine published to npm as `@mainsoft/agent-cms` (MIT). Read `docs/roadmap/README.md` first: it says what is done, what comes next and how work is done here.

- **No model calls.** Nothing here imports a model library (a test in `src/parts.test.ts` refuses it). Features that call models live outside this repository and plug into the extension points: plugins (`definePlugin`), hooks, admin `slots`, tools, the search connector. When such a feature needs something new here, add a generic extension point, named for what it does.
- **No names of private projects** in code, docs, commits or PR text.
- The hosted docs site (agent-cms-docs.vercel.app) is maintained outside this repository. It installs this package from npm and serves the admin screens with `npx @mainsoft/agent-cms registry build`.
- Releases: PR → CI → merge → tag `vX.Y.Z` → `publish.yml` publishes `latest`. Every package change merged to `main` is also published under the npm tag `next` (`x.y.z-next.<date>.<sha>`).
- Commands are always written `npx @mainsoft/agent-cms …`. Korean UI copy uses 입니다체: sentences end in -습니다/-ㅂ니다, short labels are noun phrases, never 해요체 or spoken softeners (`src/tone.ts` and a test in `src/parts.test.ts` keep it). Commits follow Conventional Commits.
