import Link from "next/link";

/** Three dots, two joined: the product in one glyph. */
export function Mark() {
  return (
    <svg viewBox="0 0 26 26" aria-hidden="true">
      <path d="M5 18.5 L13 7 L21 15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.55" />
      <circle cx="5" cy="18.5" r="3.2" fill="var(--moss)" />
      <circle cx="13" cy="7" r="3.2" fill="currentColor" />
      <circle cx="21" cy="15" r="3.2" fill="var(--pollen)" />
    </svg>
  );
}

export function Brand() {
  return (
    <Link href="/" className="brand" aria-label="SeeDots home">
      <Mark />
      <span>SeeDots</span>
    </Link>
  );
}
