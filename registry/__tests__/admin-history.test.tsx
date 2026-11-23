// The bundled admin's router (admin/history.ts): Back / Forward away from a page with unsaved edits
// asks; when the person stays, the step is undone with history.go, so no entry is added and the
// forward entries are kept.
import "./setup";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { usePath, type Go } from "../../admin/history";

let allow = true;
let asked = 0;
const mayLeave = () => (asked++, allow);
let go!: Go;

function App() {
  const [path, g] = usePath(mayLeave);
  go = g;
  return <p data-testid="path">{path}</p>;
}

const shown = () => screen.getByTestId("path").textContent;
const idx = () => (window.history.state as { cmsIdx?: number } | null)?.cmsIdx;
/** history.go fires popstate later (as in browsers): wait until the address settles on `path`. */
async function settle(path: string) {
  await waitFor(() => assert.equal(window.location.pathname, path));
  // One more turn: a refused step is undone with a second traversal.
  await act(() => new Promise((r) => setTimeout(r, 20)));
}

const scrollTo = window.scrollTo;
beforeEach(() => {
  window.scrollTo = (() => {}) as typeof window.scrollTo;
  allow = true;
  asked = 0;
  window.history.replaceState(null, "", "/admin/a");
});

afterEach(() => {
  cleanup();
  window.scrollTo = scrollTo;
  window.history.replaceState(null, "", "/");
});

test("router: every move keeps its index in history.state", async () => {
  render(<App />);
  assert.equal(idx(), 0);
  act(() => go("/admin/b"));
  assert.equal(idx(), 1);
  act(() => go("/admin/c", true));
  assert.equal(idx(), 1, "replacing keeps the place");
  act(() => go("/admin/d"));
  assert.equal(idx(), 2);
  assert.equal(shown(), "/admin/d");
});

test("router: Back refused on a page with unsaved edits stays, without a new entry; Forward still works", async () => {
  render(<App />);
  act(() => go("/admin/b"));
  act(() => go("/admin/c"));
  const length = window.history.length;
  // Back once: allowed.
  window.history.back();
  await settle("/admin/b");
  assert.equal(shown(), "/admin/b");
  assert.equal(idx(), 1);

  // Now the page has unsaved edits: Back is refused.
  asked = 0;
  allow = false;
  window.history.back();
  await settle("/admin/b");
  assert.equal(asked, 1);
  assert.equal(shown(), "/admin/b");
  assert.equal(idx(), 1, "back on the same entry");
  assert.equal(window.history.length, length, "no entry was added");

  // The forward entry is still there.
  allow = true;
  window.history.forward();
  await settle("/admin/c");
  assert.equal(shown(), "/admin/c");
  assert.equal(idx(), 2);
});

test("router: Forward refused stays too, and Back afterwards goes where it should", async () => {
  render(<App />);
  act(() => go("/admin/b"));
  act(() => go("/admin/c"));
  window.history.go(-2);
  await settle("/admin/a");
  assert.equal(shown(), "/admin/a");

  allow = false;
  window.history.forward();
  await settle("/admin/a");
  assert.equal(shown(), "/admin/a");
  assert.equal(idx(), 0);

  // Both forward entries are kept: two steps forward lands on c.
  allow = true;
  window.history.go(2);
  await settle("/admin/c");
  assert.equal(shown(), "/admin/c");
  assert.equal(idx(), 2);
});
