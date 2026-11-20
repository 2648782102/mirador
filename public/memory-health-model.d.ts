// Types for public/memory-health-model.js, for the TypeScript that imports it (src/memory/memory-health.ts
// and its tests). The browser never loads this file: no page or module imports it, and the bundle
// (src/http/bundle.ts) follows imports from public/'s entry points only.

export const FALLBACK_TITLE_CHARS: number;

/** The first meaningful line of `content` without Markdown, at most `max` long; null when it has no text. */
export function fallbackTitle(content: unknown, max?: number): string | null;

/** A memory row's title, or its fallback (`fallback: true`). */
export function displayTitle(title: unknown, content: unknown): { text: string | null; fallback: boolean };

export type HealthSectionId = 'suspicious' | 'unmatched' | 'untitled' | 'duplicates' | 'topicKey' | 'passive';

/** The findings of a GET /api/memory/health answer, in the card's order; [] without `totals`. */
export function healthSections(health: unknown): Array<{ id: HealthSectionId; count: unknown; items: unknown[] }>;
