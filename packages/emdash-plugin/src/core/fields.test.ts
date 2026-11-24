import { describe, expect, it } from "vitest";

import { autoReplyMessage } from "./auto-reply.ts";
import {
  flattenFields,
  formatNotification,
  formLayout,
  isPlainEmail,
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

  it("strips control characters and line separators from the subject and intro line", () => {
    const dirty = "Contact\r\nBcc: attacker@evil.com\u0000\u007f\u0085\u2028Line\u2029End";
    const { subject, text } = formatNotification(null, dirty, { name: "Ada" }, "t");
    expect(subject).toBe("New submission: Contact Bcc: attacker@evil.com Line End");
    expect(text.split("\n")[0]).toBe(
      'New submission for "Contact Bcc: attacker@evil.com Line End"',
    );
  });

  it("caps long subjects at 150 characters with an ellipsis", () => {
    const longName = "A".repeat(200);
    const { subject } = formatNotification(null, longName, { name: "Ada" }, "t");
    expect(subject.length).toBe(150);
    expect(subject.endsWith("…")).toBe(true);
    expect(subject.startsWith("New submission: ")).toBe(true);
  });
});

describe("isPlainEmail", () => {
  it("accepts bare ASCII email addresses", () => {
    for (const valid of [
      "ada@example.com",
      "ada.lovelace+tag@sub.example.co.uk",
      "a@b.co",
      "user_1-2!#$%&'*+/=?^`{|}~@example.test",
      "user@xn--bcher-kva.example",
    ]) {
      expect(isPlainEmail(valid)).toBe(true);
    }
  });

  it("rejects header injection, display names, quotes, control chars and invalid hostnames", () => {
    for (const invalid of [
      "Ada <ada@example.com>",
      '"ada"@example.com',
      "ada@example.com\r\nBcc: evil@example.com",
      "ada\n@example.com",
      "ada\u0000@example.com",
      "ada,bob@example.com",
      "ada;bob@example.com",
      "(comment)ada@example.com",
      " ada@example.com",
      "ada@example.com ",
      "ada@localhost",
      "ada@127.0.0.1",
      ".ada@example.com",
      "ada.@example.com",
      "ada..b@example.com",
      "ada@-example.com",
      "ada@example-.com",
      `${"a".repeat(65)}@example.com`,
      `ada@${"a".repeat(64)}.com`,
      `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`,
    ]) {
      expect(isPlainEmail(invalid)).toBe(false);
    }
  });
});

describe("replyToAddress", () => {
  it("takes the first valid email field, then a field named email", () => {
    expect(replyToAddress(layout, { email: "ada@example.com" })).toBe("ada@example.com");
    expect(replyToAddress(layout, { email: "Ada <ada@example.com>" })).toBeNull();
    expect(
      replyToAddress(layout, { email: "ada@example.com\r\nBcc: evil@example.com" }),
    ).toBeNull();
    expect(replyToAddress(layout, { email: '"ada"@example.com' })).toBeNull();
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

describe("autoReplyMessage", () => {
  const reply = { subject: "Thanks", text: "We got your message." };

  it("accepts a plain ASCII address and rejects header-injection or display-name addresses", () => {
    expect(autoReplyMessage(reply, layout, { email: "ada@example.com" })).toEqual({
      to: "ada@example.com",
      ...reply,
    });
    for (const bad of [
      "Ada <ada@example.com>",
      '"ada"@example.com',
      "ada@example.com\r\nBcc: evil@example.com",
      "ada\u0007@example.com",
      "ada,bob@example.com",
    ]) {
      expect(autoReplyMessage(reply, layout, { email: bad })).toBeNull();
    }
  });
});
