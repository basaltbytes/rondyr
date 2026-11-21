import { describe, expect, it } from "vitest";

import {
  flattenFields,
  formatNotification,
  formLayout,
  replyToAddress,
  type FormLayout,
} from "./fields.ts";

const layout: FormLayout = {
  slug: "contact",
  name: "Contact",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "email", label: "Email", type: "email" },
    { name: "topics", label: "Topics", type: "checkbox-group" },
    { name: "consent", label: "Consent", type: "checkbox" },
    { name: "people", label: "People", type: "number" },
    { name: "cv", label: "CV", type: "file" },
    { name: "page", label: "Page", type: "hidden" },
    { name: "message", label: "Message", type: "textarea" },
  ],
};

describe("flattenFields", () => {
  it("joins lists, stringifies other values and keeps only the form's own fields", () => {
    const fields = flattenFields(layout, {
      name: "Ada",
      email: "ada@example.com",
      topics: ["Pottery", "Glazing"],
      consent: true,
      people: 3,
      cv: "cv.pdf",
      page: "/contact",
      message: "",
      _hp: "",
      "cf-turnstile-response": "token",
    });
    expect(fields).toEqual({
      name: "Ada",
      email: "ada@example.com",
      topics: "Pottery, Glazing",
      consent: "true",
      people: "3",
      page: "/contact",
    });
  });

  it("leaves out missing and null values", () => {
    expect(flattenFields(layout, { name: null })).toEqual({});
  });

  it("trims values as the forms plugin stores them, and leaves out blank ones", () => {
    const fields = flattenFields(layout, {
      name: "  Ada ",
      email: " ",
      message: "\r\n\r\nHello,\r\nthe kiln is ready.\r\n",
    });
    expect(fields).toEqual({ name: "Ada", message: "Hello,\r\nthe kiln is ready." });
  });
});

describe("formLayout", () => {
  it("marks required fields only", () => {
    const { fields } = formLayout("contact", "Contact", [
      { name: "email", label: "Email", type: "email", required: true },
      { name: "name", label: "Name", type: "text", required: false },
      { name: "page", label: "Page", type: "hidden" },
    ]);
    expect(fields).toEqual([
      { name: "email", label: "Email", type: "email", required: true },
      { name: "name", label: "Name", type: "text" },
      { name: "page", label: "Page", type: "hidden" },
    ]);
  });
});

describe("formatNotification", () => {
  it("follows the forms plugin's text format", () => {
    const { subject, text } = formatNotification(
      layout,
      "Rondyr name",
      { name: "Ada", page: "/contact", message: "Hello", extra: "Kept" },
      "2026-11-20T13:20:00.000Z",
    );
    expect(subject).toBe("New submission: Contact");
    expect(text).toBe(
      [
        'New submission for "Contact"',
        "",
        "Name: Ada",
        "Message: Hello",
        "extra: Kept",
        "",
        "Submitted at: 2026-11-20T13:20:00.000Z",
      ].join("\n"),
    );
  });

  it("uses the Rondyr form name and field names without a layout", () => {
    const { subject, text } = formatNotification(null, "Classes", { email: "a@b.co" }, "t");
    expect(subject).toBe("New submission: Classes");
    expect(text).toContain("email: a@b.co");
  });
});

describe("replyToAddress", () => {
  it("takes the first valid email field, then a field named email", () => {
    expect(replyToAddress(layout, { email: "ada@example.com" })).toBe("ada@example.com");
    expect(replyToAddress(layout, { email: "Ada <ada@example.com>" })).toBeNull();
    expect(replyToAddress(null, { email: "ada@example.com" })).toBe("ada@example.com");
    expect(replyToAddress(null, {})).toBeNull();
  });

  it("prefers a required email field to an optional one before it, as the forms plugin does", () => {
    const quote: FormLayout = {
      slug: "quote",
      name: "Quote",
      fields: [
        { name: "office", label: "Your office's address", type: "email" },
        { name: "contact", label: "Your address", type: "email", required: true },
      ],
    };
    const both = { office: "office@example.com", contact: "ada@example.com" };
    expect(replyToAddress(quote, both)).toBe("ada@example.com");
    expect(replyToAddress(quote, { office: "office@example.com" })).toBe("office@example.com");
    // The first filled field decides; a value that isn't a plain address gives no Reply-To.
    expect(replyToAddress(quote, { ...both, contact: "ada@example.com," })).toBeNull();
  });
});
