/** Unit tests of the public media origin list (code review MJ-24). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { httpOrigin, originList, publicMediaOrigins } from "./media-origins";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("media origins", () => {
  it("keeps only http(s) origins and drops paths", () => {
    expect(httpOrigin("https://media.example.org/bucket/x")).toBe("https://media.example.org");
    expect(httpOrigin("javascript:alert(1)")).toBeNull();
    expect(httpOrigin("ws://api.example.org")).toBeNull();
    expect(httpOrigin("")).toBeNull();
    expect(originList(" https://a.example/b , not a url,http://localhost:9000/x")).toEqual([
      "https://a.example",
      "http://localhost:9000",
    ]);
  });

  it("combines the API origin with the configured media bases, de-duplicated", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://quiz.example.org");
    vi.stubEnv(
      "NEXT_PUBLIC_MEDIA_ORIGINS",
      "https://quiz.example.org/kabuki-neko-media,https://cdn.example.org",
    );
    expect(publicMediaOrigins()).toEqual(["https://quiz.example.org", "https://cdn.example.org"]);
  });
});
