// Types for scripts/slot.mjs (plain JS so the workflow can run it without installing packages).
export function postTime(id: string, b?: unknown): number
export function nextSlot(o?: { now?: number, any?: boolean }): string
