import type { EmailLanguage } from "./email.ts";

// Inline styles keep emails readable and consistent across Gmail, Apple Mail,
// Outlook, Fastmail, and Proton without loading remote fonts or images.
const ink = "#111110";
const bodyText = "#3d3d3a";
const muted = "#6f6e69";
const line = "#e4e3df";
const page = "#f4f3ec";
const card = "#ffffff";
const accent = "#a34a28";
const font = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";
const mono = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const layoutCopy = {
  en: {
    brand: "Rondyr",
    linkFallback: "If the button does not work, copy this link into your browser:",
    footer: "Rondyr, self-hosted form backend.",
  },
  fr: {
    brand: "Rondyr",
    linkFallback: "Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :",
    footer: "Rondyr, gestionnaire de formulaires auto-hébergé.",
  },
} as const;

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface EmailAction {
  readonly label: string;
  readonly url: string;
}

export interface EmailFieldEntry {
  readonly label: string;
  readonly value: string;
  readonly empty: boolean;
}

export interface EmailMetaRow {
  readonly label: string;
  readonly value: string;
}

export interface EmailLayoutOptions {
  readonly language: EmailLanguage;
  readonly title: string;
  readonly bodyHtml: ReadonlyArray<string>;
  readonly action?: EmailAction;
  /** Explains in the footer why the recipient received this email. */
  readonly reason: string;
  readonly maxWidth?: number;
}

/** Escape arbitrary text for safe insertion into HTML text nodes and attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A standard body paragraph for an HTML email. */
export function emailParagraph(text: string): string {
  return `<p style="color:${bodyText};font-size:15px;line-height:24px;margin:0 0 16px;">${escapeHtml(text)}</p>`;
}

/** A prominent, monospaced verification code block. */
export function emailCode(code: string): string {
  return `<p style="background-color:${page};border:1px solid ${line};border-radius:8px;color:${ink};font-family:${mono};font-size:32px;font-variant-numeric:tabular-nums;font-weight:600;letter-spacing:0.3em;line-height:40px;margin:0 0 16px;padding:16px 0;text-align:center;">${escapeHtml(code)}</p>`;
}

/** A clean key-value field list for form submissions, preserving line breaks safely. */
export function emailFields(entries: ReadonlyArray<EmailFieldEntry>): string {
  if (entries.length === 0) return "";
  const rows = entries
    .map(({ label, value, empty }, index) => {
      const borderTop = index === 0 ? "" : `border-top:1px solid ${line};`;
      const renderedValue = empty
        ? `<span style="color:${muted};font-style:italic;">${escapeHtml(value)}</span>`
        : escapeHtml(value).replaceAll("\n", "<br />");
      return `<tr><td style="${borderTop}padding:12px 0;">
        <div style="color:${ink};font-size:13px;font-weight:600;line-height:18px;margin:0 0 4px;">${escapeHtml(label)}</div>
        <div style="color:${bodyText};font-size:15px;line-height:22px;margin:0;white-space:pre-wrap;word-break:break-word;">${renderedValue}</div>
      </td></tr>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 20px;">${rows}</table>`;
}

/** Subtle metadata rows placed below a divider inside the card. */
export function emailMeta(rows: ReadonlyArray<EmailMetaRow>): string {
  if (rows.length === 0) return "";
  const lines = rows
    .map(
      ({ label, value }) =>
        `<div style="color:${muted};font-size:13px;line-height:20px;margin:0;"><strong style="color:${bodyText};font-weight:600;">${escapeHtml(label)}</strong> ${escapeHtml(value)}</div>`,
    )
    .join("");
  return `<hr style="border:0;border-top:1px solid ${line};margin:20px 0 16px;" />${lines}`;
}

/**
 * Render a clean, table-based light HTML email paired with its plain text version.
 * Uses no external images, remote fonts, or hidden zero-width preheader padding.
 */
export function renderEmailLayout(options: EmailLayoutOptions): string {
  const words = layoutCopy[options.language];
  const width = options.maxWidth ?? 520;
  const escapedUrl = options.action === undefined ? "" : escapeHtml(options.action.url);
  const actionHtml =
    options.action === undefined
      ? ""
      : `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 24px;"><tr><td style="background-color:${accent};border-radius:8px;">
          <a href="${escapedUrl}" style="color:#ffffff;display:inline-block;font-family:${font};font-size:15px;font-weight:600;line-height:20px;padding:12px 20px;text-decoration:none;">${escapeHtml(options.action.label)}</a>
        </td></tr></table>
        <hr style="border:0;border-top:1px solid ${line};margin:0 0 16px;" />
        <p style="color:${muted};font-size:13px;line-height:20px;margin:0;">${escapeHtml(words.linkFallback)}<br /><a href="${escapedUrl}" style="color:${muted};word-break:break-all;">${escapedUrl}</a></p>`;

  return [
    "<!DOCTYPE html>",
    `<html lang="${options.language}" dir="ltr">`,
    `<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${escapeHtml(options.title)}</title></head>`,
    `<body style="background-color:${page};font-family:${font};margin:0;padding:32px 16px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><td align="center">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;max-width:${width}px;text-align:left;">`,
    `<tr><td style="color:${ink};font-family:${font};font-size:15px;font-weight:600;line-height:20px;padding:0 0 16px;">${escapeHtml(words.brand)}</td></tr>`,
    `<tr><td style="background-color:${card};border:1px solid ${line};border-radius:12px;font-family:${font};padding:32px 28px;">`,
    `<h1 style="color:${ink};font-size:22px;font-weight:600;line-height:28px;margin:0 0 16px;">${escapeHtml(options.title)}</h1>`,
    ...options.bodyHtml,
    actionHtml,
    `</td></tr>`,
    `<tr><td style="color:${muted};font-family:${font};font-size:12px;line-height:18px;padding:16px 0 0;">${escapeHtml(options.reason)} ${escapeHtml(words.footer)}</td></tr>`,
    `</table>`,
    `</td></tr></table>`,
    `</body>`,
    `</html>`,
  ].join("");
}
