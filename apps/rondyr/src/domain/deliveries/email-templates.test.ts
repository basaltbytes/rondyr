import { assert, it } from "@effect/vitest";

import { emailOtpEmail } from "../organizations/authentication.ts";
import { invitationEmail } from "../organizations/invitation-email.ts";
import { SubmissionId } from "../submissions/submission.id.ts";
import { DeliveryId } from "./delivery.ts";
import { emailContent, testEmailContent } from "./email-message.ts";
import { confirmationEmail } from "./recipient-confirmation.ts";

const timestamp = 1_795_183_380_000; // 20 November 2026 at 14:03:00 UTC
const zeroWidthPattern = /[\u200B-\u200F\uFEFF]/u;

function assertCleanHtml(html: string, language: "en" | "fr") {
  assert.isTrue(html.startsWith("<!DOCTYPE html>"), "HTML must start with DOCTYPE");
  assert.include(html, `<html lang="${language}" dir="ltr">`);
  assert.notMatch(html, zeroWidthPattern, "HTML must not contain zero-width padding characters");
  assert.notInclude(html, "<img", "HTML must not embed external images");
  assert.notInclude(html, "<script", "HTML must not contain script tags");
}

it("renders the Email OTP message in English and French", () => {
  const en = emailOtpEmail("482913", "en");
  assertCleanHtml(en.html, "en");
  assert.strictEqual(en.subject, "Your Rondyr sign-in code");
  assert.include(en.html, "482913");
  assert.include(en.html, "10 minutes");
  assert.include(en.text, "482913");
  assert.include(en.text, "10 minutes");

  const fr = emailOtpEmail("905124", "fr");
  assertCleanHtml(fr.html, "fr");
  assert.strictEqual(fr.subject, "Votre code de connexion Rondyr");
  assert.include(fr.html, "905124");
  assert.include(fr.html, "10 minutes");
  assert.include(fr.text, "905124");
  assert.include(fr.text, "10 minutes");
});

it("renders the team invitation email with CTA button and fallback link in English and French", () => {
  const link = "https://forms.example.test/invitation#secret-token-value";
  const en = invitationEmail(link, timestamp, "en");
  assertCleanHtml(en.html, "en");
  assert.strictEqual(en.subject, "Invitation to Rondyr");
  assert.include(en.html, `href="${link}"`);
  assert.include(en.html, "View invitation");
  assert.include(en.html, "20 November 2026");
  assert.include(en.text, link);
  assert.include(en.text, "20 November 2026");

  const fr = invitationEmail(link, timestamp, "fr");
  assertCleanHtml(fr.html, "fr");
  assert.strictEqual(fr.subject, "Invitation à Rondyr");
  assert.include(fr.html, `href="${link}"`);
  assert.include(fr.html, "Voir l’invitation");
  assert.include(fr.html, "20 novembre 2026");
  assert.include(fr.text, link);
  assert.include(fr.text, "20 novembre 2026");
});

it("renders the recipient confirmation email with CTA button and fallback link in English and French", () => {
  const link = "https://forms.example.test/confirm-recipient#confirm-token-value";
  const en = confirmationEmail(link, timestamp, "en");
  assertCleanHtml(en.html, "en");
  assert.strictEqual(en.subject, "Confirm your email address for Rondyr");
  assert.include(en.html, `href="${link}"`);
  assert.include(en.html, "Confirm email address");
  assert.include(en.html, "20 November 2026");
  assert.include(en.text, link);
  assert.include(en.text, "20 November 2026");

  const fr = confirmationEmail(link, timestamp, "fr");
  assertCleanHtml(fr.html, "fr");
  assert.strictEqual(fr.subject, "Confirmez votre adresse e-mail pour Rondyr");
  assert.include(fr.html, `href="${link}"`);
  assert.include(fr.html, "Confirmer l’adresse e-mail");
  assert.include(fr.html, "20 novembre 2026");
  assert.include(fr.text, link);
  assert.include(fr.text, "20 novembre 2026");
});

it("escapes HTML in form names, field names, and visitor values, and preserves line breaks", () => {
  const deliveryId = DeliveryId.make("0f6c1a62-6b8e-4c43-9f5e-2d3a9b7c4e11");
  const email = emailContent(
    {
      deliveryId,
      submission: {
        id: SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b01"),
        receivedAt: timestamp,
        formPublicId: "contact",
        formName: `Pottery & <script>alert("x")</script>`,
      },
      fields: {
        "name <b>bold</b>": "Alice & 'Bob'",
        message: "First line\r\nSecond line\n<img src=x onerror=alert(1)>",
      },
    },
    "en",
  );

  assertCleanHtml(email.html, "en");
  assert.include(email.html, "Pottery &amp; &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.include(email.html, "name &lt;b&gt;bold&lt;/b&gt;");
  assert.include(email.html, "Alice &amp; &#39;Bob&#39;");
  assert.include(email.html, "First line<br />Second line<br />&lt;img src=x onerror=alert(1)&gt;");
  assert.include(email.html, deliveryId);
});

it("renders the test email HTML in English and French", () => {
  const testId = DeliveryId.make("0f6c1a62-6b8e-4c43-9f5e-2d3a9b7c4e11");
  const en = testEmailContent({ testId, formName: "Classes", sentAt: timestamp }, "en");
  assertCleanHtml(en.html, "en");
  assert.include(en.html, "Classes");
  assert.include(en.html, testId);

  const fr = testEmailContent({ testId, formName: "Classes", sentAt: timestamp }, "fr");
  assertCleanHtml(fr.html, "fr");
  assert.include(fr.html, "Classes");
  assert.include(fr.html, testId);
});
