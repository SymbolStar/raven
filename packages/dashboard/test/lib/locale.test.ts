import { describe, expect, it } from "vitest";
import { detectLocale, isLocale, translate } from "@/lib/locale";

describe("locale helpers", () => {
  it("uses Simplified Chinese for Chinese browser locales", () => {
    expect(detectLocale("zh-CN")).toBe("zh-CN");
    expect(detectLocale("zh-TW")).toBe("zh-CN");
  });

  it("falls back to English for other browser locales", () => {
    expect(detectLocale("en-US")).toBe("en");
    expect(detectLocale(undefined)).toBe("en");
  });

  it("accepts only supported locale values", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("zh-CN")).toBe(true);
    expect(isLocale("fr")).toBe(false);
  });

  it("returns Chinese navigation labels", () => {
    expect(translate("zh-CN", "overview")).toBe("概览");
    expect(translate("en", "overview")).toBe("Overview");
  });
});
