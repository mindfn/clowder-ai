/* eslint-disable @next/next/no-img-element -- the header intentionally reuses the canonical local PWA asset */

/** Clowder AI's canonical transparent three-cat mark. */
export function CatCafeLogo({ className = 'w-6 h-6' }: { className?: string }) {
  return <img src="/icons/icon-512x512.png" alt="" aria-hidden="true" draggable={false} className={className} />;
}
