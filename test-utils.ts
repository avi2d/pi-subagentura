import { vi } from "vitest";

/**
 * Re-import a module under vitest, clearing the module cache first.
 * Use this in tests that stub process.env or globalThis before import,
 * or that need to re-evaluate module-level state.
 */
export async function importFresh<T = unknown>(specifier: string): Promise<T> {
    vi.resetModules();
    return import(specifier) as Promise<T>;
}
