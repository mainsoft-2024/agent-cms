"use client";

import { useEffect, useState } from "react";

type Item = { id: string; text: string; level: number };

/** "On this page": marks the heading being read with a teal rule. */
export function TocList({ items }: { items: Item[] }) {
  const [active, setActive] = useState(items[0]?.id ?? "");

  useEffect(() => {
    const heads = items.map((it) => document.getElementById(it.id)).filter((el): el is HTMLElement => !!el);
    if (!heads.length) return;
    // The last heading above a line a little below the sticky header is the one being read.
    const update = () => {
      let current = heads[0].id;
      for (const h of heads) if (h.getBoundingClientRect().top <= 120) current = h.id;
      setActive(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [items]);

  return (
    <ul>
      {items.map((h) => {
        const on = h.id === active;
        return (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              aria-current={on ? "location" : undefined}
              className={`block py-1 ${on ? "border-l-2 border-[var(--color-butler-teal)] text-[var(--color-ink)]" : "border-l border-[var(--color-rule-gray)] text-[var(--color-warm-gray)] hover:text-[var(--color-ink)]"} ${h.level === 3 ? (on ? "pl-[23px]" : "pl-6") : on ? "pl-[11px]" : "pl-3"}`}
            >
              {h.text}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
