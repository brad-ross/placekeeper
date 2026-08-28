import { describe, expect, it } from "vitest";
import {
  ScopedExternalLaunchRegistrations,
  parseScopedExternalLaunchUri,
} from "../src/external-launch-registration.js";

describe("scoped external launch registrations", () => {
  it("routes only one exact registration and canonical output", () => {
    const registrations = new ScopedExternalLaunchRegistrations();
    const one = registrations.register({
      registrationId: "registration_identifier_1234",
      canonicalOutputPath: "/work/paper.pdf",
      windowId: "window_identifier_1234",
    });
    expect(registrations.resolve({
      registrationId: "registration_identifier_1234",
      outputPath: "/work/paper.pdf",
    })).toEqual(one);
    expect(() => registrations.resolve({ outputPath: "/work/paper.pdf" })).toThrow(/registration/iu);
    expect(() => registrations.resolve({
      registrationId: "registration_identifier_1234",
      outputPath: "/other/paper.pdf",
    })).toThrow(/output/iu);
  });

  it("fails closed when multiple windows claim one canonical output", () => {
    const registrations = new ScopedExternalLaunchRegistrations();
    registrations.register({
      registrationId: "registration_identifier_1234",
      canonicalOutputPath: "/work/paper.pdf",
      windowId: "window_identifier_1234",
    });
    expect(() => registrations.register({
      registrationId: "registration_identifier_5678",
      canonicalOutputPath: "/work/paper.pdf",
      windowId: "window_identifier_5678",
    })).toThrow(/multiple VS Code windows/iu);
  });

  it("accepts only the packaged extension URI route", () => {
    expect(parseScopedExternalLaunchUri({
      path: "/placekeeper/external",
      query: "registration=registration_identifier_1234&pdf=%2Fwork%2Fpaper.pdf",
    })).toEqual({
      registrationId: "registration_identifier_1234",
      outputPath: "/work/paper.pdf",
    });
    expect(() => parseScopedExternalLaunchUri({
      path: "/placekeeper/external",
      query: "registration=registration_identifier_1234&pdf=https%3A%2F%2Fexample.invalid%2Fpaper.pdf",
    })).toThrow(/local PDF/iu);
    expect(() => parseScopedExternalLaunchUri({
      path: "/placekeeper/external",
      query: "registration=registration_identifier_1234&pdf=%2Fwork%2Fpaper.pdf&extra=x",
    })).toThrow(/route/iu);
  });
});
