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

// ── 0.22.0 review fixes ──

/** Holds every caller until `n` have arrived, so two writers really read the same state. */
function barrier(n: number) {
  let waiting: (() => void)[] = [];
  return () =>
    new Promise<void>((ok) => {
      waiting.push(ok);
      if (waiting.length >= n) {
        for (const w of waiting) w();
        waiting = [];
      }
    });
}

test("forms review: two saves that read the same form: exactly one wins, the other is form_conflict; the version goes up once", async () => {
  const { cms, repo } = setup();
  await contact(cms);
  const meet = barrier(2);
  const orig = repo.updateRecord.bind(repo);
  repo.updateRecord = async (kind, id, patch) => {
    if (kind === "form") await meet();
    return orig(kind, id, patch);
  };
  const a = STEPS.map((s) => ({ ...s, fields: [...s.fields] }));
  a[0].fields.push({ key: "phone", label: "Phone", kind: "text" });
  const b = STEPS.map((s) => ({ ...s, fields: [...s.fields] }));
  b[0].fields.push({ key: "city", label: "City", kind: "text" });
  const results = await Promise.all([
    code(cms.forms.update(admin, "contact", { steps: a })),
    code(cms.forms.update(admin, "contact", { steps: b })),
  ]);
  assert.deepEqual([...results].sort(), ["form_conflict", "ok"]);
  repo.updateRecord = orig;
  const f = await cms.forms.get(admin, "contact");
  assert.equal(f.version, 2, "one version for one save");
  const keys = f.steps[0].fields.map((x) => x.key);
  assert.equal(
    Number(keys.includes("phone")) + Number(keys.includes("city")),
    1,
  );
});

test("forms review: one upload token sent by two submissions at once: exactly one is accepted", async () => {
  const { cms, api, priv, repo } = setup();
  await contact(cms);
  const g = await api.formUploadGrant("contact", {
    field: "shot",
    name: "screen.png",
    size: 200,
    mime: "image/png",
  });
  await api.formUpload("contact", g, new Blob([png()]));
  // Both pass the checks before either claims (a slow storage head).
  const meet = barrier(2);
  const head = priv.head.bind(priv);
  priv.head = async (k: string) => {
    const r = await head(k);
    await meet();
    return r;
  };
  const bug = { ...good, topic: "bug", version: "2.1", seats: undefined };
  const results = await Promise.all([
    code(cms.forms.submit("contact", { ...bug, shot: [g.token] }, { ip: "1.0.0.1" })),
    code(cms.forms.submit("contact", { ...bug, shot: [g.token] }, { ip: "1.0.0.2" })),
  ]);
  priv.head = head;
  assert.deepEqual([...results].sort(), ["form_upload_invalid", "ok"]);
  assert.equal(repo.formSubmissions.length, 1);
  assert.equal(
    [...priv.objects.keys()].filter((k) => k.startsWith("_cms/forms/") && !k.includes("_tmp")).length,
    1,
    "one permanent copy",
  );
  // A grant uploads once even when two PUTs race.
  const g2 = await api.formUploadGrant("contact", {
    field: "shot",
    name: "b.png",
    size: 200,
    mime: "image/png",
  });
  const puts = await Promise.all([
    code(cms.forms.upload("contact", g2.token, png())),
    code(cms.forms.upload("contact", g2.token, png())),
  ]);
  assert.deepEqual([...puts].sort(), ["form_upload_invalid", "ok"]);
  // The temporary key holds no file name (it is in storage logs and the PUT address).
  assert.ok(![...priv.objects.keys()].some((k) => k.includes("b.png")));
});

test("forms review: a submission whose insert fails leaves no permanent file, and the same token works on retry", async () => {
  const { cms, api, priv, repo, clock } = setup();
  await contact(cms);
  const g = await api.formUploadGrant("contact", {
    field: "shot",
    name: "screen.png",
    size: 200,
    mime: "image/png",
  });
  await api.formUpload("contact", g, new Blob([png()]));
  const insert = repo.insertFormSubmission.bind(repo);
  repo.insertFormSubmission = async () => {
    throw new Error("database went away");
  };
  const bug = { ...good, topic: "bug", version: "2.1", seats: undefined };
  await assert.rejects(
    cms.forms.submit("contact", { ...bug, shot: [g.token] }, { ip: "1.0.0.1" }),
    /database went away/,
  );
  assert.deepEqual(
    [...priv.objects.keys()].filter((k) => k.startsWith("_cms/forms/") && !k.startsWith("_cms/forms/_tmp")),
    [],
    "no orphan permanent object",
  );
  assert.ok(
    [...priv.objects.keys()].some((k) => k.startsWith("_cms/forms/_tmp")),
    "the upload is still there",
  );
  repo.insertFormSubmission = insert;
  await cms.forms.submit("contact", { ...bug, shot: [g.token] }, { ip: "1.0.0.1" });
  assert.equal(repo.formSubmissions.length, 1);
  assert.equal(repo.formSubmissions[0].files.length, 1);
  assert.ok(priv.objects.has(repo.formSubmissions[0].files[0].key));
  assert.ok(
    ![...priv.objects.keys()].some((k) => k.startsWith("_cms/forms/_tmp")),
  );
  // A copy that could not be undone is recorded on the grant and swept later.
  const g2 = await api.formUploadGrant("contact", {
    field: "shot",
    name: "two.png",
    size: 200,
    mime: "image/png",
  });
  await api.formUpload("contact", g2, new Blob([png()]));
  repo.insertFormSubmission = async () => {
    throw new Error("again");
  };
  const del = priv.delete.bind(priv);
  priv.delete = async (k: string) => {
    if (k.startsWith("_cms/forms/") && !k.includes("_tmp")) throw new Error("storage down");
    return del(k);
  };
  await assert.rejects(
    cms.forms.submit("contact", { ...bug, shot: [g2.token] }, { ip: "1.0.0.3" }),
  );
  priv.delete = del;
  repo.insertFormSubmission = insert;
  const left = () =>
    [...priv.objects.keys()].filter(
      (k) => k.startsWith("_cms/forms/") && !k.includes("_tmp") && !repo.formSubmissions.some((s) => s.files.some((f) => f.key === k)),
    );
  assert.equal(left().length, 1, "the copy stayed");
  // A day later the sweep deletes it (and the upload never sent).
  clock.t += 2 * 86_400_000;
  await cms.cron();
  assert.equal(left().length, 0);
  assert.ok(![...priv.objects.keys()].some((k) => k.includes("_tmp")));
  assert.equal(repo.formSubmissions.length, 1, "the saved submission keeps its file");
  assert.ok(priv.objects.has(repo.formSubmissions[0].files[0].key));
});

test("forms review: browser-style multipart with a mixed-case boundary is taken", async () => {
  const { cms, call, repo } = setup();
  await contact(cms);
  const boundary = "----WebKitFormBoundaryAbCdEfGh12345678";
  const parts = Object.entries({ ...good, agree: "on" })
    .map(
      ([k, v]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
    )
    .join("");
  const res = await call("/forms/contact", {
    method: "POST",
    body: `${parts}--${boundary}--\r\n`,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      accept: "application/json",
    },
  });
  assert.equal(res.status, 201, await res.clone().text());
  assert.equal(repo.formSubmissions[0].data.name, "Ann");
  // Real FormData through fetch's own encoder, upper-case media type too.
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...good, agree: "on" })) fd.append(k, String(v));
  const encoded = new Request("http://x.test/", { method: "POST", body: fd });
  const ct = encoded.headers.get("content-type")!.replace("multipart/form-data", "Multipart/Form-Data");
  const res2 = await call("/forms/contact", {
    method: "POST",
    body: await encoded.arrayBuffer(),
    headers: { "content-type": ct, accept: "application/json" },
    ip: "198.51.100.2",
  });
  assert.equal(res2.status, 201);
});

test("forms review: verify gets the parsed fields (a captcha token the form does not declare) and a readable request", async () => {
  const seen: { raw: unknown; body: string }[] = [];
  const { cms, call } = setup({
    forms: {
      verify: async (req, c) => {
        seen.push({ raw: c.raw["cf-turnstile-response"], body: req ? await req.text() : "" });
        return c.raw["cf-turnstile-response"] === "tok-1";
      },
    },
  });
  await contact(cms);
  const form = new URLSearchParams({ ...good, agree: "on", "cf-turnstile-response": "tok-1" } as Record<string, string>);
  const res = await call("/forms/contact", {
    method: "POST",
    body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  });
  assert.equal(res.status, 201);
  assert.equal(seen[0].raw, "tok-1");
  assert.ok(seen[0].body.includes("cf-turnstile-response=tok-1"), "the request's body can still be read");
  const bad = await call("/forms/contact", {
    method: "POST",
    body: JSON.stringify({ ...good, "cf-turnstile-response": "nope" }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(bad.status, 403);
});

test("forms review: forms.clientIp decides the sender's address (an appending proxy; a forged first entry does not dodge the limit)", async () => {
  const { clientIpBehind } = await import("./limits");
  const { cms, call } = setup({ forms: { clientIp: clientIpBehind(1) } });
  await contact(cms);
  const send = (xff: string) =>
    call("/forms/contact", {
      method: "POST",
      body: JSON.stringify(good),
      headers: { "content-type": "application/json", "x-forwarded-for": xff, "x-real-ip": "10.9.9.9" },
    });
  for (let i = 0; i < 5; i++) assert.equal((await send(`6.6.6.${i}, 203.0.113.50`)).status, 201);
  assert.equal((await send("7.7.7.7, 203.0.113.50")).status, 429, "the proxy's entry is the address");
  assert.equal((await send("6.6.6.1, 203.0.113.51")).status, 201, "another real address is not held up");
  const req = new Request("http://x.test/", { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" } });
  assert.equal(clientIpBehind(1)(req), "3.3.3.3");
  assert.equal(clientIpBehind(2)(req), "2.2.2.2");
  assert.equal(clientIpBehind(4)(req), null);
});

test("forms review: the Node adapter refuses a form submission past 64 KB while it arrives, not after 8 MB", async () => {
  const { Readable } = await import("node:stream");
  const { toWebRequest, bodyLimit } = await import("./adapters/node");
  let pulled = 0;
  const chunk = new Uint8Array(16 * 1024).fill(120);
  const make = (url: string, headers: Record<string, string> = {}) => {
    pulled = 0;
    const r = Readable.from(
      (function* () {
        for (let i = 0; i < 512; i++) {
          pulled += chunk.length;
          yield chunk;
        }
      })(),
    ) as unknown as import("node:http").IncomingMessage;
    Object.assign(r, { method: "POST", url, headers: { host: "app.test", "content-type": "application/json", ...headers } });
    return r;
  };
  await assert.rejects(toWebRequest(make("/api/cms/forms/contact")), (e: { status?: number }) => e.status === 413);
  assert.ok(pulled <= 64 * 1024 + 2 * chunk.length, `read ${pulled} bytes before 413`);
  await assert.rejects(
    toWebRequest(make("/api/cms/forms/contact", { "content-length": String(8 * 1024 * 1024) })),
    (e: { status?: number }) => e.status === 413,
  );
  assert.equal(pulled, 0, "a declared length past the limit is refused before reading");
  assert.equal(bodyLimit("POST", "/api/cms/forms/contact/uploads"), 8 * 1024 * 1024, "uploads keep their own bound");
  assert.equal(bodyLimit("POST", "/cms/forms/contact", { basePath: "/cms" }), 64 * 1024);
  assert.equal(bodyLimit("POST", "/api/cms/collections/guide"), 8 * 1024 * 1024);
});

test("forms review: upload tokens are not in request logs; file names are not in events or the audit log by default", async () => {
  const { cms, api, call } = setup();
  await contact(cms);
  const paths: string[] = [];
  cms.onTelemetry((e) => {
    if (e.type === "request") paths.push(e.path);
  });
  const seen: { event: string; detail: unknown }[] = [];
  cms.subscribe((e) => void seen.push(e as { event: string; detail: unknown }));
  const g = await api.formUploadGrant("contact", { field: "shot", name: "passport-kim.png", size: 200, mime: "image/png" });
  await api.formUpload("contact", g, new Blob([png()]));
  assert.ok(paths.includes("/forms/contact/uploads/:token"), paths.join(" "));
  assert.ok(!paths.some((p) => p.includes(g.token.slice(0, 20))));
  await api.submitForm("contact", { ...good, topic: "bug", version: "1", seats: undefined, shot: [g.token] });
  await tick();
  const ev = seen.find((e) => e.event === "form.submitted");
  assert.ok(ev);
  assert.ok(!JSON.stringify(ev.detail).includes("passport-kim"), "no file name in the event");
  const sub = (await api.formSubmissions("contact")).items[0];
  await api.submissionFileLink("contact", sub.id, sub.files[0].id);
  const audit = JSON.stringify((await cms.audit(admin, { limit: 50 })).entries);
  assert.ok(!audit.includes("passport-kim"), "no file name in the audit log");
  assert.ok(audit.includes(sub.files[0].id));
  void call;
});

test("forms review: retention deletes files first; a row whose file cannot be deleted stays and goes on the next run", async () => {
  const { cms, api, priv, repo, clock } = setup({ retention: {} });
  await contact(cms);
  const g = await api.formUploadGrant("contact", { field: "shot", name: "s.png", size: 200, mime: "image/png" });
  await api.formUpload("contact", g, new Blob([png()]));
  await cms.forms.submit("contact", { ...good, topic: "bug", version: "1", seats: undefined, shot: [g.token] }, { ip: "1.1.1.1" });
  await cms.forms.submit("contact", good, { ip: "1.1.1.2" });
  const fileKey = repo.formSubmissions[0].files[0].key;
  const del = priv.delete.bind(priv);
  priv.delete = async (k: string) => {
    if (k === fileKey) throw new Error("storage down");
    return del(k);
  };
  clock.t += 400 * 86_400_000;
  await cms.cron();
  assert.equal(repo.formSubmissions.length, 1, "the row without files went; the one whose file failed stayed");
  assert.equal(repo.formSubmissions[0].files[0].key, fileKey);
  priv.delete = del;
  clock.t += 86_400_000; // retention runs once a day
  await cms.cron();
  assert.equal(repo.formSubmissions.length, 0);
  assert.ok(!priv.objects.has(fileKey));
});

test("forms review: CSV export takes the list's filters (status and search)", async () => {
  const { cms, api } = setup();
  await contact(cms);
  for (const [i, name] of ["Ann", "Bob", "Acme Corp"].entries())
    await cms.forms.submit("contact", { ...good, name }, { ip: `10.1.0.${i}` });
  const page = await api.formSubmissions("contact");
  const bob = page.items.find((x) => x.data.name === "Bob")!;
  await api.markSubmission("contact", bob.id, "spam");
  const rows = (csv: string) => csv.replace(/^\ufeff/, "").split("\r\n").filter(Boolean).length - 1;
  assert.equal(rows((await api.exportSubmissions("contact")).csv), 2, "default: not spam");
  assert.equal(rows((await api.exportSubmissions("contact", { status: ["spam"] })).csv), 1);
  assert.equal(rows((await api.exportSubmissions("contact", ["spam"])).csv), 1, "a bare status list still works");
  const acme = (await api.exportSubmissions("contact", { q: "acme" })).csv;
  assert.equal(rows(acme), 1);
  assert.ok(acme.includes("Acme Corp"));
  assert.equal(rows((await api.exportSubmissions("contact", { status: ["new", "read"], q: "bob" })).csv), 0);
});

test("forms review: the admin sees whether files can be taken; a required file field cannot be turned on without them", async () => {
  const none = setup({ storage: false });
  const fileReq: FormStep[] = [
    { title: "", fields: [{ key: "name", label: "Name", kind: "text" }, { key: "cv", label: "CV", kind: "file", required: true }] },
  ];
  assert.equal(
    await code(none.cms.forms.create(admin, { slug: "jobs", title: "Jobs", enabled: true, steps: fileReq })),
    "form_uploads_unavailable",
  );
  const off = await none.cms.forms.create(admin, { slug: "jobs", title: "Jobs", enabled: false, steps: fileReq });
  assert.equal(off.uploads, false);
  assert.equal((await none.api.form("jobs")).uploads, false);
  assert.equal((await none.api.forms())[0].uploads, false);
  const e = await none.cms.forms.update(admin, "jobs", { enabled: true }).catch((x) => x);
  assert.equal(e.code, "form_uploads_unavailable");
  assert.equal(e.params.field, "cv");
  // Optional file fields are fine (they just take no files).
  const optional = fileReq.map((s) => ({ ...s, fields: s.fields.map((f) => ({ ...f, required: false })) }));
  assert.equal((await none.cms.forms.update(admin, "jobs", { enabled: true, steps: optional })).enabled, true);
  const me = (await (await none.call("/_me")).json()) as { forms: { uploads: boolean } };
  assert.equal(me.forms.uploads, false);
  const yes = setup();
  assert.equal((await yes.cms.forms.create(admin, { slug: "jobs", title: "Jobs", enabled: true, steps: fileReq })).uploads, true);
});

test("forms review: definition problems are codes, so Korean messages are wholly Korean", async () => {
  const { ko } = await import("./messages/ko");
  const { formatMessage } = await import("./errors");
  const { cms } = setup();
  const bad: FormStep[] = [
    { title: "", fields: [{ key: "Bad Key", label: "", kind: "text" }, { key: "t", label: "T", kind: "select", options: [] }] },
  ];
  const e = await cms.forms.create(admin, { slug: "x", title: "X", steps: bad }).catch((x) => x);
  assert.equal(e.code, "form_invalid");
  assert.equal(e.params.issue, "key");
  assert.equal(e.params.field, "Bad Key");
  assert.ok(Number(e.params.more) >= 2);
  assert.ok(e.diagnostics.length >= 3);
  assert.match(String(e.params.reason), /lowercase letters/, "English reason kept");
  const text = formatMessage(ko, "form_invalid", e.params);
  assert.ok(!/[a-z]{3,}/i.test(text.replace(/"Bad Key"/, "")), text);
  for (const d of e.diagnostics as { params: Record<string, string> }[]) {
    const t = formatMessage(ko, "form_invalid", d.params).replace(/"[^"]*"/g, "");
    assert.ok(!/[a-z]{3,}/i.test(t), t);
  }
  const notify = await cms.forms.create(admin, { slug: "y", title: "Y", steps: STEPS, settings: { notify: ["not-mail"] } }).catch((x) => x);
  assert.equal(formatMessage(ko, "form_invalid", notify.params), "폼을 저장할 수 없음: 이메일 주소가 아님: not-mail");
  assert.equal(formatMessage(ko, "form_upload_invalid", { reason: "used" }), "파일을 받지 못함 (이미 쓴 토큰). 다시 골라야 함");
});

// ── 0.22.0 review, 3rd round ──

test("forms review (3rd): the upload sweep pages past grants whose files cannot be deleted", async () => {
  const { cms, repo, priv, clock } = setup();
  await contact(cms);
  const old = clock.t - 2 * 86_400_000;
  // 650 stale grants, oldest first: 200 whose file cannot be deleted, 250 that can, 200 that cannot.
  for (let i = 0; i < 650; i++) {
    const bad = i < 200 || i >= 450;
    await repo.insertRecord({
      kind: "form_upload",
      scope: "x",
      data: { status: "uploaded", field: "shot", tmp: `_cms/forms/_tmp/${bad ? "bad" : "ok"}-${i}`, size: 1, mime: "image/png", name: "a.png", expires: 0 },
      at: new Date(old + i).toISOString(),
    });
  }
  const del = priv.delete.bind(priv);
  priv.delete = async (k: string) => {
    if (k.includes("/bad-")) throw new Error("storage down");
    return del(k);
  };
  clock.t += 86_400_000;
  await cms.cron();
  priv.delete = del;
  const left = (await repo.listRecords({ kind: "form_upload", limit: 1000 })).map((r) => String((r.data as { tmp: string }).tmp));
  assert.equal(left.filter((k) => k.includes("/ok-")).length, 0, "every grant that could go went");
  assert.equal(left.filter((k) => k.includes("/bad-")).length, 400, "the others stay for the next run");
});

test("forms review (3rd): a copy that lands but answers with an error is still removed when the submission fails", async () => {
  const { cms, api, priv } = setup();
  await contact(cms);
  const g = await api.formUploadGrant("contact", { field: "shot", name: "s.png", size: 200, mime: "image/png" });
  await api.formUpload("contact", g, new Blob([png()]));
  const copy = priv.copy.bind(priv);
  priv.copy = async (from: string, to: string) => {
    await copy(from, to);
    throw new Error("timeout after the copy");
  };
  const bug = { ...good, topic: "bug", version: "2.1", seats: undefined };
  await assert.rejects(cms.forms.submit("contact", { ...bug, shot: [g.token] }, { ip: "1.0.0.9" }), /timeout after the copy/);
  priv.copy = copy;
  assert.deepEqual(
    [...priv.objects.keys()].filter((k) => k.startsWith("_cms/forms/") && !k.startsWith("_cms/forms/_tmp")),
    [],
    "no permanent copy left behind",
  );
  await cms.forms.submit("contact", { ...bug, shot: [g.token] }, { ip: "1.0.0.9" });
});

test("forms review: a choice field keeps its nextOption, so a removed choice's value is never handed out again", async () => {
  const { cms } = setup();
  const made = await cms.forms.create(admin, {
    slug: "pick",
    title: "Pick",
    steps: [{ title: "", fields: [{ key: "topic", label: "Topic", kind: "select", options: [{ value: "option_1", label: "A" }, { value: "option_3", label: "C" }], nextOption: 4 } as never] }],
  });
  const field = made.steps[0].fields[0] as { nextOption?: number };
  assert.equal(field.nextOption, 4);
  const again = await cms.forms.get(admin, "pick");
  assert.equal((again.steps[0].fields[0] as { nextOption?: number }).nextOption, 4);
});
