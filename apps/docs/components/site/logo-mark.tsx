/**
 * The agent-cms mark: one page, two text cursors. Ink for the person, teal for the agent,
 * editing the same document. Drawn on a 24px grid with 2px strokes so it holds at 16px.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="square" className={className} aria-hidden focusable="false">
      <rect x="4" y="2" width="16" height="20" stroke="var(--color-ink, #1c1917)" />
      <path d="M8 7h3M8 17h3M9.5 7v10" stroke="var(--color-ink, #1c1917)" />
      <path d="M13 7h3M13 17h3M14.5 7v10" stroke="var(--color-butler-teal, #25b1b1)" />
    </svg>
  );
}
