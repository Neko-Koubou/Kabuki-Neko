import * as domMatchers from "@testing-library/jest-dom/matchers";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, vi } from "vitest";

// jest-dom 7's /vitest adapter uses Vitest 4's one-parameter Assertion type.
// Register standalone matchers against Vitest 5's typed extension point instead.
expect.extend(domMatchers);
declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Module augmentation must match Vitest's generic parameters.
  interface Assertion<
    R extends void | Promise<void> = void,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Required by Vitest declaration merging.
    T = unknown,
  > extends TestingLibraryMatchers<{ asymmetricMatch(value: unknown): boolean }, R> {}
}

class TestMediaQueryList extends EventTarget implements MediaQueryList {
  matches = false;
  onchange: MediaQueryList["onchange"] = null;

  constructor(readonly media: string) {
    super();
  }

  addListener(callback: Parameters<MediaQueryList["addListener"]>[0]): void {
    if (callback) this.addEventListener("change", callback as EventListener);
  }

  removeListener(callback: Parameters<MediaQueryList["removeListener"]>[0]): void {
    if (callback) this.removeEventListener("change", callback as EventListener);
  }

  override dispatchEvent(event: Event): boolean {
    if (event.type === "change" && "matches" in event && typeof event.matches === "boolean") {
      this.matches = event.matches;
      this.onchange?.call(this, event as MediaQueryListEvent);
    }
    return super.dispatchEvent(event);
  }
}

export const resizeObservers = new Set<TestResizeObserver>();

class TestResizeObserver implements ResizeObserver {
  readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.add(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    resizeObservers.delete(this);
  }

  emit(entries: ResizeObserverEntry[]): void {
    this.callback(
      entries.filter((entry) => this.targets.has(entry.target)),
      this,
    );
  }
}

beforeEach(() => {
  const mediaQueries = new Map<string, TestMediaQueryList>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      let mediaQuery = mediaQueries.get(query);
      if (!mediaQuery) {
        mediaQuery = new TestMediaQueryList(query);
        mediaQueries.set(query, mediaQuery);
      }
      return mediaQuery;
    }),
  );
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
});

afterEach(() => {
  cleanup();
  for (const observer of resizeObservers) observer.disconnect();
  resizeObservers.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
