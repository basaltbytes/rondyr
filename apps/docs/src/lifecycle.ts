// The message lifecycle of the landing page: one message, followed from the form of a pottery
// studio's site to the To review folder. The page animates it with excerpts of the dashboard,
// and /index.md lists the same steps as text.
import english from "../../rondyr/src/dashboard/locales/en/translation.json" with { type: "json" };

/** Puts the values of a text of the dashboard in its `{{name}}` places. */
function fill(text: string, values: Readonly<Record<string, string | number>>): string {
  return text.replaceAll(/\{\{(\w+)\}\}/gu, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`The text "${text}" needs a value for "${name}".`);
    return String(value);
  });
}

/** A score between 0 and 1 as the dashboard writes it in English. */
export const percent = (score: number) => `${Math.round(score * 100)}%`;

const address = "https://forms.claywork.example/f/0cd2103d-dd4e-4258-9bed-5dce882004a3";

/** The demo data of the dashboard's screenshots: Claywork Studio and the message from Sam. */
export const story = {
  form: {
    emoji: "🏺",
    name: "Contact",
    business:
      "Pottery studio in Lyon offering wheel-throwing workshops and handmade stoneware ceramics.",
  },
  /** The address of the Rondyr instance, and the submission address of the form. */
  instance: "forms.claywork.example",
  address,
  shortAddress: `${new URL(address).pathname.slice(0, 11)}…`,
  /** The page of the studio's site that has the form. */
  site: "www.claywork.example/contact",
  sender: { name: "Sam", email: "sam@bookings.example" },
  message:
    "We help ceramics studios fill weekday classes with local groups. We can send you workshop leads each month and handle the first call. Would you like to see our pricing?",
  receivedAt: "14:03",
  scores: { spam: 0.02, solicitation: 0.93, relevance: 0.98 },
  /** The default thresholds of the AI analysis. */
  thresholds: { possibleSpam: 0.3, probableSpam: 0.7, solicitation: 0.5, relevance: 0.5 },
  repetition: { sender: 3, content: 2 },
  quota: { used: 7, limit: "1,000" },
} as const;

export interface LifecycleStep {
  readonly id: "create" | "connect" | "submit" | "reception" | "analysis" | "review";
  readonly title: string;
  /** One paragraph of plain text. */
  readonly text: string;
}

export const lifecycleIntro =
  "One message, followed from the contact form of a pottery studio to the folder where it waits for a decision.";

export const lifecycleSteps: readonly LifecycleStep[] = [
  {
    id: "create",
    title: "Create a form and describe your business",
    text: "A form needs a name, and one or two sentences about what you do. The AI analysis reads that description later, to tell a customer's question from a message that has nothing to do with you.",
  },
  {
    id: "connect",
    title: "Paste the address into your form",
    text: "Rondyr gives the form a submission address that never changes. Put it in the action attribute of an HTML form on any site, or send JSON to it with fetch.",
  },
  {
    id: "submit",
    title: "A visitor sends a message",
    text: "This one is from Sam, who sells lead generation to ceramics studios and pitches it through the studio's contact form. Your site gets its answer once Rondyr has saved the message, so Sam sees the thank-you page like any other visitor.",
  },
  {
    id: "reception",
    title: "Reception checks",
    text: "Rondyr checks the message as it arrives, without a model: the site it comes from, the hidden honeypot field, Turnstile, repeated messages, blocked words and the daily limit. None of them stops Sam's message, so it goes to the AI analysis.",
  },
  {
    id: "analysis",
    title: "AI analysis",
    text: "Jev, a classifier model on Workers AI, scores the message for spam, for sales outreach and for relevance to your business. Sam's message isn't spam and it is about ceramics, but it scores 93% for sales outreach, and a message above 50% goes to review.",
  },
  {
    id: "review",
    title: "To review",
    text: "Rondyr doesn't delete a message it doubts. This one waits in To review with its reason until you archive it, or accept it and send it to your email, webhook or connector.",
  },
];

const { inbox, status, verification } = english;
const { checks, verdicts } = verification;
const salesOutreach = status.reasons.solicitation;

/**
 * The texts of the dashboard that its excerpts show, read from its English locale so an
 * excerpt says what the dashboard says. The type check fails on a key the locale no longer has.
 */
export const dashboardText = {
  forms: inbox.sections.forms,
  newForm: {
    title: inbox.forms.newTitle,
    details: inbox.forms.details.new,
    name: inbox.forms.name,
    business: inbox.business.label,
    businessHint: inbox.business.hint,
    add: inbox.forms.add,
  },
  formPage: {
    address: inbox.forms.address.title,
    addressHint: inbox.forms.address.active,
    copy: inbox.forms.address.copy,
    status: inbox.forms.status,
    active: inbox.forms.statuses.active,
  },
  classification: {
    title: verification.title,
    check: verification.table.check,
    onArrival: verification.table.onArrival,
    reception: verification.table.intake,
    aiAnalysis: verification.table.ai,
    model: inbox.policy.models.jev,
    test: verification.test.action,
    // Where the reception ends and the AI analysis starts.
    analyzing: verdicts.analyzing,
    analyzingDetail: verdicts.analyzingDetail,
  },
  reception: {
    received: verification.timeline.received,
    checks: [
      { icon: "globe", name: checks.origin.name, value: checks.origin.allowed },
      { icon: "eye-off", name: checks.honeypot.name, value: checks.honeypot.empty },
      { icon: "shield", name: checks.turnstile.name, value: checks.turnstile.passed },
      {
        icon: "repeat-2",
        name: checks.sender.name,
        value: fill(checks.repetitionValue, { value: 0, threshold: story.repetition.sender }),
        pips: { value: 0, threshold: story.repetition.sender },
      },
      {
        icon: "repeat-2",
        name: checks.content.name,
        value: fill(checks.repetitionValue, { value: 0, threshold: story.repetition.content }),
        pips: { value: 0, threshold: story.repetition.content },
      },
      { icon: "ban", name: checks.blocked.name, value: checks.blocked.passed },
      { icon: "gauge", name: checks.quota.name, value: fill(checks.quota.used, story.quota) },
    ],
  },
  analysis: {
    sent: verification.timeline.classificationStarted,
    verdict: fill(verdicts.solicitation, { score: percent(story.scores.solicitation) }),
    verdictDetail: fill(verdicts.aboveThreshold, {
      threshold: percent(story.thresholds.solicitation),
    }),
    spam: checks.spam.name,
    solicitation: checks.solicitation.name,
    relevance: checks.relevance.name,
  },
  review: {
    sent: fill(verification.timeline.quarantined, { reason: salesOutreach }),
    folder: inbox.folders.quarantined,
    reason: salesOutreach,
    archive: inbox.reader.archive,
    accept: inbox.reader.accept,
    acceptAndSend: inbox.reader.acceptAndSend,
  },
} as const;
