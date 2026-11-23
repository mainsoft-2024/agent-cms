/** 0.22.0: forms (definitions, the public form, submissions, files, spam, limits, events, retention). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createCms, defineCollection } from "./cms";
import { isCmsError } from "./errors";
import { createCmsHandler } from "./http";
import { createRestClient, isCmsRemoteError } from "./client";
import { MemoryRepo } from "./repo";
import { MemoryStorage } from "./storage";
import {
  checkSubmission,
  conditionHolds,
  definitionProblems,
  visibleKeys,
  visibleSteps,
  type FormStep,
} from "./form-rules";
import { toCsv, type FormsOptions } from "./forms";
import type { Actor } from "./types";

const admin: Extract<Actor, { kind: "user" }> = {
  kind: "user",
  id: "u1",
  label: "Kim",
  isAdmin: true,
};
const writer: Extract<Actor, { kind: "user" }> = {
  kind: "user",
  id: "u2",
  label: "Lee",
  isAdmin: false,
};
const BASE = "http://app.test/api/cms";
const tick = () => new Promise((r) => setTimeout(r, 5));

const STEPS: FormStep[] = [
  {
    title: "Who",
    fields: [
      { key: "name", label: "Name", kind: "text", required: true },
      { key: "email", label: "Email", kind: "email", required: true },
    ],
  },
  {
    title: "What",
    fields: [
      {
        key: "topic",
        label: "Topic",
        kind: "select",
        required: true,
        options: [
          { value: "bug", label: "Bug" },
          { value: "sales", label: "Sales" },
        ],
      },
      {
        key: "version",
        label: "Version",
        kind: "text",
        required: true,
        showIf: { field: "topic", op: "eq", value: "bug" },
      },
      {
        key: "seats",
        label: "Seats",
        kind: "number",
        min: 1,
        max: 500,
        showIf: { field: "topic", op: "eq", value: "sales" },
      },
      {
        key: "shot",
        label: "Screenshot",
        kind: "file",
        accept: ["image/*"],
        maxSize: 1000,
        showIf: { field: "topic", op: "eq", value: "bug" },
      },
      {
        key: "message",
        label: "Message",
        kind: "textarea",
        required: true,
        max: 2000,
      },
      { key: "agree", label: "I agree", kind: "checkbox", required: true },
    ],
  },
];

const png = (n = 200) => {
  const b = new Uint8Array(n);
  b.set([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48,
    0x44, 0x52,
  ]);
  return b;
};

function setup(
  o: {
    forms?: boolean | FormsOptions;
    storage?: boolean;
    retention?: { submissionsDays?: number };
  } = {},
) {
  const clock = { t: Date.parse("2026-11-23T00:00:00Z") };
  const sent: { url: string; body: string; event: string | null }[] = [];
  const priv = new MemoryStorage({ name: "private" });
  const pub = new MemoryStorage({
    name: "public",
    publicUrl: "https://cdn.test",
  });
  const repo = new MemoryRepo();
  const errors: string[] = [];
  const cms = createCms({
    repo,
    collections: [
      defineCollection({ slug: "guide", label: "Guide", visibility: "public" }),
    ],
    now: () => new Date(clock.t),
    warn: () => {},
    onError: (e) => void errors.push(String(e)),
    cronSecret: "c".repeat(32),
    secretsKey: "s".repeat(40),
    forms: o.forms ?? true,
    retention: o.retention,
    media:
      o.storage === false
        ? { stores: { public: { visibility: "public", adapter: pub } } }
        : {
            stores: {
              public: { visibility: "public", adapter: pub },
              private: { visibility: "private", adapter: priv },
            },
          },
    webhooks: {
      resolveHost: async () => ["93.184.216.34"],
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push({
          url: String(input),
          body: String(init?.body),
          event: new Headers(init?.headers).get("x-cms-event"),
        });
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    },
  });
  const session = { user: admin as Actor | null };
  const handler = createCmsHandler({
    cms,
    resolveUser: async () =>
      session.user?.kind === "user" ? session.user : null,
  });
  const call = (path: string, init: RequestInit & { ip?: string } = {}) =>
    handler(
      new Request(`${BASE}${path}`, {
        ...init,
        headers: {
          "x-forwarded-for": init.ip ?? "203.0.113.7",
          ...(init.headers as Record<string, string> | undefined),
        },
      }),
    );
  const api = createRestClient({
    url: BASE,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(new Request(String(input), init))) as typeof fetch,
  });
  return { cms, repo, clock, sent, priv, session, handler, call, api, errors };
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e) => (isCmsError(e) || isCmsRemoteError(e) ? e.code : Promise.reject(e)),
  );
const good = {
  name: "Ann",
  email: "ann@example.com",
  topic: "sales",
  seats: "12",
  message: "Hello",
  agree: true,
};

async function contact(cms: ReturnType<typeof setup>["cms"], enabled = true) {
  return cms.forms.create(admin, {
    slug: "contact",
    title: "Contact",
    enabled,
    steps: STEPS,
    settings: { successMessage: "Thanks!", notify: ["team@example.com"] },
  });
}

test("form rules: conditions, hidden fields dropped, steps skipped, values normalized", () => {
  assert.equal(
    conditionHolds({ field: "a", op: "eq", value: "x" }, { a: "x" }),
    true,
  );
  assert.equal(
    conditionHolds({ field: "a", op: "neq", value: "x" }, { a: "y" }),
    true,
  );
  assert.equal(
    conditionHolds({ field: "a", op: "in", value: ["x", "y"] }, { a: "y" }),
    true,
  );
  assert.equal(
    conditionHolds(
      { field: "a", op: "contains", value: "b" },
      { a: ["a", "b"] },
    ),
    true,
  );
  assert.equal(conditionHolds({ field: "a", op: "empty" }, { a: "  " }), true);
  assert.equal(
    conditionHolds({ field: "a", op: "filled" }, { a: false }),
    false,
  );
  assert.equal(
    conditionHolds({ field: "a", op: "eq", value: true }, { a: true }),
    true,
  );
  // A condition on a hidden field never holds (chains collapse).
  const chain: FormStep[] = [
    {
      title: "",
      fields: [
        { key: "a", label: "A", kind: "text" },
        {
          key: "b",
          label: "B",
          kind: "text",
          showIf: { field: "a", op: "eq", value: "x" },
        },
        {
          key: "c",
          label: "C",
          kind: "text",
          showIf: { field: "b", op: "filled" },
        },
      ],
    },
  ];
  assert.deepEqual([...visibleKeys(chain, { a: "y", b: "1", c: "2" })], ["a"]);
  assert.deepEqual(
    [...visibleKeys(chain, { a: "x", b: "1" })],
    ["a", "b", "c"],
  );
  const r = checkSubmission(STEPS, {
    ...good,
    version: "1.2",
    extra: "no",
    seats: " 12 ",
  });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.values, {
    name: "Ann",
    email: "ann@example.com",
    topic: "sales",
    seats: 12,
    message: "Hello",
    agree: true,
  });
  const bad = checkSubmission(STEPS, {
    name: "",
    email: "nope",
    topic: "bug",
    seats: "9999",
    message: "x",
  });
  assert.deepEqual(
    bad.problems.map((p) => `${p.field}:${p.code}`),
    [
      "name:form_required",
      "email:form_email",
      "version:form_required",
      "agree:form_required",
    ],
  );
  assert.deepEqual(
    checkSubmission(STEPS, {}, { steps: [0] }).problems.map((p) => p.field),
    ["name", "email"],
  );
  const two: FormStep[] = [
    { title: "1", fields: [{ key: "k", label: "K", kind: "checkbox" }] },
    {
      title: "2",
      fields: [
        {
          key: "z",
          label: "Z",
          kind: "text",
          showIf: { field: "k", op: "eq", value: true },
        },
      ],
    },
  ];
  assert.deepEqual(visibleSteps(two, {}), [0]);
  assert.deepEqual(visibleSteps(two, { k: true }), [0, 1]);
  // Definitions: conditions look back, keys are unique, patterns compile.
  assert.match(
    definitionProblems([
      {
        title: "",
        fields: [
          {
            key: "a",
            label: "A",
            kind: "text",
            showIf: { field: "b", op: "eq", value: 1 },
          },
          { key: "b", label: "B", kind: "text" },
        ],
      },
    ]).join(),
    /earlier field/,
  );
  assert.match(
    definitionProblems([
      {
        title: "",
        fields: [
          { key: "a", label: "A", kind: "text" },
          { key: "a", label: "A", kind: "text" },
        ],
      },
    ]).join(),
    /used twice/,
  );
  assert.match(
    definitionProblems([
      {
        title: "",
        fields: [{ key: "a", label: "A", kind: "text", pattern: "(" }],
      },
    ]).join(),
    /regular expression/,
  );
  assert.match(
    definitionProblems([
      {
        title: "",
        fields: [{ key: "a", label: "A", kind: "select", options: [] }],
      },
    ]).join(),
    /options/,
  );
});

test("forms: admins build forms; roles with the forms target may too; others are refused", async () => {
  const { cms, clock } = setup();
  const f = await contact(cms);
  clock.t += 1000;
  assert.equal(f.version, 1);
  assert.equal(
    await code(cms.forms.create(admin, { slug: "contact", title: "Again" })),
    "form_slug_taken",
  );
  assert.equal(
    await code(cms.forms.create(admin, { slug: "Bad Slug", title: "x" })),
    "form_invalid",
  );
  assert.equal(
    await code(
      cms.forms.create(admin, {
        slug: "x",
        title: "x",
        steps: [
          { title: "", fields: [{ key: "1a", label: "A", kind: "text" }] },
        ],
      }),
    ),
    "form_invalid",
  );
  assert.equal(await code(cms.forms.list(writer)), "forbidden_forms");
  assert.equal(
    await code(cms.forms.list({ kind: "anonymous" })),
    "unauthorized",
  );
  // A default form (name, email, message) when no steps are given.
  const d = await cms.forms.create(admin, { slug: "plain", title: "Plain" });
  assert.deepEqual(
    d.steps[0].fields.map((x) => x.key),
    ["name", "email", "message"],
  );
  assert.equal(d.enabled, false);

  const role = await cms.roles.create(admin, {
    name: "Support",
    permissions: { forms: { read: true } },
  });
  await cms.roles.addMember(admin, role.id, {
    id: writer.id,
    label: writer.label,
  });
  assert.equal((await cms.forms.list(writer)).length, 2);
  assert.equal(
    await code(cms.forms.update(writer, "contact", { title: "Mine" })),
    "forbidden_forms",
  );
  assert.equal(
    await code(cms.forms.removeSubmissions(writer, "contact", ["x"])),
    "forbidden_forms",
  );
  await cms.roles.update(admin, role.id, {
    permissions: { forms: { write: true, delete: true, publish: true } },
  });
  const r = (await cms.roles.list(admin)).roles.find((x) => x.id === role.id)!;
  assert.deepEqual(
    r.permissions.forms,
    { write: true, delete: true, read: true },
    "publish does not apply to forms",
  );
  const changed = await cms.forms.update(writer, "contact", {
    title: "Contact us",
    steps: [
      ...STEPS,
      { title: "More", fields: [{ key: "more", label: "More", kind: "text" }] },
    ],
  });
  assert.equal(changed.version, 2, "changing the fields bumps the version");
  assert.equal(
    (await cms.forms.update(writer, "contact", { title: "Contact" })).version,
    2,
    "a name change does not",
  );
  // A stale save is refused.
  assert.equal(
    await code(
      cms.forms.update(admin, "contact", {
        title: "Old",
        expectedUpdatedAt: f.updatedAt,
      }),
    ),
    "form_conflict",
  );
  // Off: everything answers forms_off.
  const off = setup({ forms: false });
  assert.equal(await code(off.cms.forms.list(admin)), "forms_off");
  const audits = (await cms.audit(admin, { limit: 50 })).entries.map(
    (e) => e.action,
  );
  assert.ok(audits.includes("form.create") && audits.includes("form.update"));
});

test("forms over HTTP: public definition only when on; a submission recomputes conditions and drops hidden values", async () => {
  const { cms, call, repo, session } = setup();
  await contact(cms, false);
  session.user = null;
  assert.equal(
    (await call("/forms/contact")).status,
    404,
    "a form that is off is not found",
  );
  session.user = admin;
  const preview = (await (await call("/forms/contact")).json()) as {
    form: { enabled?: boolean };
  };
  assert.equal(
    preview.form.enabled,
    false,
    "people who manage forms may preview it",
  );
  await cms.forms.update(admin, "contact", { enabled: true });
  session.user = null;
  const res = await call("/forms/contact");
  assert.equal(res.status, 200);
  const pub = (await res.json()) as {
    form: {
      honeypot: string;
      steps: FormStep[];
      uploads: boolean;
      successMessage: string;
    };
  };
  assert.equal(pub.form.honeypot, "_website");
  assert.equal(pub.form.uploads, true);
  assert.equal(pub.form.steps.length, 2);
  assert.ok(!("settings" in pub.form), "notify addresses are not public");

  const send = (body: unknown, ip?: string) =>
    call("/forms/contact", {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        origin: "https://elsewhere.test",
      },
      ip,
    });
  const bad = await send({ ...good, topic: "bug", agree: false });
  assert.equal(bad.status, 422);
  const err = (await bad.json()) as {
    error: string;
    diagnostics: { path: string; code: string }[];
  };
  assert.equal(err.error, "form_rejected");
  assert.deepEqual(
    err.diagnostics.map((d) => `${d.path}:${d.code}`),
    ["version:form_required", "agree:form_required"],
  );

  const ok = await send({ ...good, version: "should go", shot: ["nope"] });
  assert.equal(ok.status, 201);
  assert.deepEqual(await ok.json(), {
    ok: true,
    message: "Thanks!",
    redirectUrl: null,
  });
  const [row] = repo.formSubmissions;
  assert.deepEqual(
    row.data,
    {
      name: "Ann",
      email: "ann@example.com",
      topic: "sales",
      seats: 12,
      message: "Hello",
      agree: true,
    },
    "values of hidden fields are not kept",
  );
  assert.equal(row.status, "new");
  assert.match(row.ipHash ?? "", /^[0-9a-f]{32}$/);
  assert.ok(
    !JSON.stringify(row).includes("203.0.113.7"),
    "the address is never kept",
  );

  // A plain HTML form (urlencoded) gets a page back.
  const html = await call("/forms/contact", {
    method: "POST",
    body: new URLSearchParams({ ...good, seats: "3", agree: "on" }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    ip: "198.51.100.1",
  });
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await html.text(), /Thanks!/);
  // Multipart without files works; a file inside the form is refused (files come with a grant).
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...good, seats: "4", agree: "on" }))
    fd.append(k, String(v));
  const mp = await handler2(call, "/forms/contact", fd, "198.51.100.2");
  assert.equal(mp.status, 201);
  fd.append("shot", new Blob([png()], { type: "image/png" }), "a.png");
  assert.equal(
    (await handler2(call, "/forms/contact", fd, "198.51.100.3")).status,
    422,
  );
  assert.equal(repo.formSubmissions.length, 3);
});

async function handler2(
  call: ReturnType<typeof setup>["call"],
  path: string,
  fd: FormData,
  ip: string,
) {
  const r = new Request("http://x/", { method: "POST", body: fd });
  return call(path, {
    method: "POST",
    body: await r.arrayBuffer(),
    headers: {
      "content-type": r.headers.get("content-type")!,
      accept: "application/json",
    },
    ip,
  });
}

test("forms: the honeypot keeps it as spam silently; the 6th a minute from one address is 429 with Retry-After; 64 KB at most", async () => {
  const { cms, call, repo, clock, sent } = setup();
  await contact(cms);
  await cms.webhooks.create(admin, {
    name: "All",
    url: "https://hooks.test/all",
  });
  const send = (body: unknown, ip = "203.0.113.9") =>
    call("/forms/contact", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      ip,
    });
  const spam = await send({ ...good, _website: "http://buy.example" });
  assert.equal(spam.status, 201, "the bot is told it worked");
  assert.equal(repo.formSubmissions[0].status, "spam");
  for (let i = 0; i < 4; i++) assert.equal((await send(good)).status, 201);
  const sixth = await send(good);
  assert.equal(sixth.status, 429);
  assert.ok(Number(sixth.headers.get("retry-after")) > 0);
  assert.equal(
    ((await sixth.json()) as { error: string }).error,
    "rate_limited",
  );
  assert.equal(
    (await send(good, "203.0.113.10")).status,
    201,
    "another address is not held up",
  );
  clock.t += 61_000;
  assert.equal(
    (await send(good)).status,
    201,
    "a minute later it goes through",
  );
  const big = await send(
    { ...good, message: "x".repeat(70 * 1024) },
    "192.0.2.50",
  );
  assert.equal(big.status, 413);

  // Events: spam makes none; a kept one carries ids and field names, not the values.
  await tick();
  await cms.cron();
  const posted = sent.filter((x) => x.event === "form.submitted");
  assert.equal(posted.length, 6);
  const payload = JSON.parse(posted[0].body) as {
    event: string;
    detail: Record<string, unknown>;
  };
  assert.equal(payload.detail.form, "contact");
  assert.ok(Array.isArray(payload.detail.fields));
  assert.ok(
    !posted[0].body.includes("ann@example.com"),
    "no personal values in the webhook by default",
  );
});

test("forms: verify(req) can refuse; notify gets the lines; eventValues puts values in the event", async () => {
  const notes: { to: string[]; lines: string[] }[] = [];
  let allow = false;
  const { cms, call } = setup({
    forms: {
      verify: (req) => allow && req?.headers.get("x-captcha") === "ok",
      notify: (e) =>
        void notes.push({
          to: e.to,
          lines: e.lines.map((l) => `${l.label}=${l.value}`),
        }),
      eventValues: true,
    },
  });
  await contact(cms);
  const seen: unknown[] = [];
  cms.subscribe((e) => void seen.push(e));
  const send = (h: Record<string, string> = {}) =>
    call("/forms/contact", {
      method: "POST",
      body: JSON.stringify(good),
      headers: { "content-type": "application/json", ...h },
    });
  const no = await send();
  assert.equal(no.status, 403);
  assert.equal(
    ((await no.json()) as { error: string }).error,
    "form_verify_failed",
  );
  allow = true;
  assert.equal((await send({ "x-captcha": "ok" })).status, 201);
  await tick();
  assert.deepEqual(notes, [
    {
      to: ["team@example.com"],
      lines: [
        "Name=Ann",
        "Email=ann@example.com",
        "Topic=Sales",
        "Seats=12",
        "Message=Hello",
        "I agree=✓",
      ],
    },
  ]);
  const ev = seen.find(
    (e) => (e as { event: string }).event === "form.submitted",
  ) as { detail: { values: Record<string, unknown> } };
  assert.equal(ev.detail.values.email, "ann@example.com");
});

test("forms: files go through a one-time grant into private storage, are checked, and open with a short link", async () => {
  const { cms, api, priv, repo, clock } = setup();
  await contact(cms);
  const bugAnswer = { ...good, topic: "bug", version: "2.1", seats: undefined };
  assert.equal(
    await code(
      api.formUploadGrant("contact", {
        field: "message",
        name: "a.png",
        size: 10,
      }),
    ),
    "form_upload_invalid",
  );
  assert.equal(
    await code(
      api.formUploadGrant("contact", {
        field: "shot",
        name: "a.png",
        size: 5000,
        mime: "image/png",
      }),
    ),
    "form_file_too_large",
  );
  assert.equal(
    await code(
      api.formUploadGrant("contact", {
        field: "shot",
        name: "a.pdf",
        size: 200,
        mime: "application/pdf",
      }),
    ),
    "form_file_type",
  );
  const g = await api.formUploadGrant("contact", {
    field: "shot",
    name: "screen.png",
    size: 200,
    mime: "image/png",
  });
  assert.equal(g.put, null, "memory storage: bytes go through the CMS");
  await api.formUpload("contact", g, new Blob([png()]));
  assert.equal(
    await code(api.formUpload("contact", g, new Blob([png()]))),
    "form_upload_invalid",
    "a grant uploads once",
  );
  // A forged or expired token is refused.
  assert.equal(
    await code(
      api.submitForm("contact", {
        ...bugAnswer,
        shot: [g.token.slice(0, -2) + "xx"],
      }),
    ),
    "form_upload_invalid",
  );
  await api.submitForm("contact", { ...bugAnswer, shot: [g.token] });
  const [row] = repo.formSubmissions;
  assert.equal(row.files.length, 1);
  assert.match(row.files[0].key, /^_cms\/forms\//);
  assert.ok(priv.objects.has(row.files[0].key));
  assert.ok(
    ![...priv.objects.keys()].some((k) => k.includes("_tmp")),
    "the upload's own key is gone",
  );
  assert.deepEqual(
    (row.data.shot as { name: string }[]).map((x) => x.name),
    ["screen.png"],
  );
  assert.equal(
    await code(api.submitForm("contact", { ...bugAnswer, shot: [g.token] })),
    "form_upload_invalid",
    "a token is sent once",
  );
  const subs = await api.formSubmissions("contact");
  assert.ok(!("key" in subs.items[0].files[0]), "storage keys are not shown");
  const link = await api.submissionFileLink(
    "contact",
    subs.items[0].id,
    subs.items[0].files[0].id,
  );
  assert.match(link.url, /^memory:\/\/private\//);
  // A file that is not what it says is refused.
  const g2 = await api.formUploadGrant("contact", {
    field: "shot",
    name: "fake.png",
    size: 50,
    mime: "image/png",
  });
  await api.formUpload(
    "contact",
    g2,
    new Blob([
      new TextEncoder().encode(
        "<html><script>alert(1)</script>".padEnd(50, " "),
      ),
    ]),
  );
  assert.equal(
    await code(api.submitForm("contact", { ...bugAnswer, shot: [g2.token] })),
    "form_file_type",
  );
  const g3 = await api.formUploadGrant("contact", {
    field: "shot",
    name: "late.png",
    size: 200,
    mime: "image/png",
  });
  clock.t += 11 * 60_000;
  assert.equal(
    await code(api.formUpload("contact", g3, new Blob([png()]))),
    "form_upload_invalid",
    "a grant lasts 10 minutes",
  );
  // Without a private store, file fields refuse files.
  const none = setup({ storage: false });
  await contact(none.cms);
  assert.equal(
    await code(
      none.api.formUploadGrant("contact", {
        field: "shot",
        name: "a.png",
        size: 200,
        mime: "image/png",
      }),
    ),
    "form_uploads_off",
  );
  // Deleting the submission deletes its file.
  await api.removeSubmission("contact", subs.items[0].id);
  assert.ok(!priv.objects.has(row.files[0].key));
});

test("forms: submissions list, filter, search, mark, bulk, delete; CSV escapes and defuses formulas", async () => {
  const { cms, api } = setup();
  await contact(cms);
  for (const [i, name] of [
    "Ann",
    '=HYPERLINK("http://x")',
    'Bo, "Jr"',
    "+1",
    "-2",
    "@cmd",
    "Multi",
  ].entries())
    await cms.forms.submit(
      "contact",
      { ...good, name, message: name === "Multi" ? "Line\nbreak" : "Hello" },
      { ip: `10.0.0.${i}` },
    );
  let page = await api.formSubmissions("contact");
  assert.equal(page.total, 7);
  assert.equal(page.counts.new, 7);
  assert.equal((await api.formSubmissions("contact", { q: "bo, " })).total, 1);
  const ids = page.items.map((x) => x.id);
  await api.markSubmission("contact", ids[0], "read");
  await api.bulkSubmissions("contact", ids.slice(1, 3), "spam");
  await api.bulkSubmissions("contact", [ids[3]], "archived");
  page = await api.formSubmissions("contact");
  assert.equal(page.total, 4, "new and read by default");
  assert.deepEqual(page.counts, { new: 3, read: 1, spam: 2, archived: 1 });
  assert.equal(
    (await api.formSubmissions("contact", { status: ["spam"] })).total,
    2,
  );
  const { csv, filename } = await api.exportSubmissions("contact");
  assert.match(filename, /^contact-2026-11-23\.csv$/);
  const text = csv.replace(/^\ufeff/, "");
  assert.ok(
    text.startsWith(
      "submitted_at,status,Name,Email,Topic,Version,Seats,Screenshot,Message,I agree\r\n",
    ),
  );
  assert.ok(
    text.includes(`"'=HYPERLINK(""http://x"")"`) ||
      text.includes("'=HYPERLINK"),
    "formulas start with '",
  );
  assert.ok(
    !/(^|,)[=+\-@]/m.test(
      text
        .split("\r\n")
        .slice(1)
        .join("\n")
        .replace(/\d{4}-\d{2}-\d{2}T[^,]+/g, ""),
    ),
    "no cell starts a formula",
  );
  assert.ok(text.includes('"Bo, ""Jr"""'));
  assert.ok(text.includes('"Line\nbreak"'));
  assert.equal(
    text.split("\r\n").filter(Boolean).length,
    1 + 5,
    "spam is left out",
  );
  assert.equal(toCsv([["a", " b", "-3"]]), `a," b",'-3\r\n`);
  const del = await api.bulkSubmissions("contact", ids.slice(0, 2), "delete");
  assert.equal(del.deleted, 2);
  // Another form's submission cannot be touched through this one.
  await cms.forms.create(admin, {
    slug: "other",
    title: "Other",
    enabled: true,
  });
  assert.equal(
    await code(api.formSubmission("other", ids[4])),
    "submission_not_found",
  );
  assert.equal(
    (await api.bulkSubmissions("other", [ids[4]], "delete")).deleted,
    0,
  );
  // Deleting the form deletes its submissions.
  assert.equal((await api.removeForm("contact")).submissions, 5);
});

test("forms: retention deletes old submissions (365 days by default, or the form's own), and stale uploads", async () => {
  const { cms, repo, clock, priv, api } = setup({ retention: {} });
  await contact(cms);
  await cms.forms.submit("contact", good, { ip: "1.1.1.1" });
  const g = await api.formUploadGrant("contact", {
    field: "shot",
    name: "s.png",
    size: 200,
    mime: "image/png",
  });
  await api.formUpload("contact", g, new Blob([png()]));
  assert.ok(
    cms.core.retention
      .rules()
      .some((r) => r.what === "form_submissions" && r.days === 365),
  );
  clock.t += 2 * 86_400_000;
  await cms.cron();
  assert.ok(
    ![...priv.objects.keys()].some((k) => k.includes("_tmp")),
    "uploads never sent go after a day",
  );
  assert.equal(repo.formSubmissions.length, 1);
  clock.t += 366 * 86_400_000;
  await cms.cron();
  assert.equal(repo.formSubmissions.length, 0);
  // A form's own shorter keepDays.
  await cms.forms.update(admin, "contact", { settings: { keepDays: 7 } });
  await cms.forms.submit("contact", good, { ip: "1.1.1.2" });
  clock.t += 8 * 86_400_000;
  await cms.cron();
  assert.equal(repo.formSubmissions.length, 0);
});
