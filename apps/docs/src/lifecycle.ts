// The message lifecycle of the landing page: one message, followed from the form of a pottery
// studio's site to the To review folder, or another one to the studio's email. The page
// animates it with excerpts of the dashboard, and /index.md lists the same steps as text.
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

/**
 * The messages that the lifecycle follows, one at a time, from the demo data of the
 * dashboard's screenshots. The first one is the message of a page whose script does not run.
 */
export const messages = [
  {
    id: "review",
    /** What the message is, in /index.md. */
    kind: "A sales pitch",
    sender: { name: "Sam", email: "sam@bookings.example" },
    text: "We help ceramics studios fill weekday classes with local groups. We can send you workshop leads each month and handle the first call. Would you like to see our pricing?",
    receivedAt: "14:03",
    scores: { spam: 0.02, solicitation: 0.93, relevance: 0.98 },
  },
  {
    id: "accepted",
    kind: "A customer's question",
    sender: { name: "Ruth", email: "ruth@mail.example" },
    text: "Could I book the Saturday wheel-throwing class for two? We're both beginners. Is an apron provided or should we bring our own?",
    receivedAt: "14:07",
    scores: { spam: 0.02, solicitation: 0.03, relevance: 0.98 },
  },
] as const;

export type Message = (typeof messages)[number];
export type MessageId = Message["id"];

/** The demo data of the dashboard's screenshots: Claywork Studio and its contact form. */
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
  /** Where the form sends an accepted message. */
  destinations: {
    email: "hello@claywork.example",
    webhook: "https://www.claywork.example/hooks/messages",
  },
  /** The default thresholds of the AI analysis. */
  thresholds: { possibleSpam: 0.3, probableSpam: 0.7, solicitation: 0.5, relevance: 0.5 },
  repetition: { sender: 3, content: 2 },
  quota: { used: 7, limit: "1,000" },
} as const;

/** The title of a step and its paragraph of plain text. */
export interface Caption {
  readonly title: string;
  readonly text: string;
}

export interface LifecycleStep {
  readonly id: "create" | "connect" | "submit" | "reception" | "analysis" | "outcome";
  /** One caption for every message, or one for each message. */
  readonly caption: Caption | Readonly<Record<MessageId, Caption>>;
}

/** The captions of a step: one when it is the same for every message, else one a message. */
export function captionsOf(
  step: LifecycleStep,
): ReadonlyArray<Caption & { readonly message?: Message }> {
  const { caption } = step;
  return "title" in caption
    ? [caption]
    : messages.map((message) => ({ ...caption[message.id], message }));
}

export const lifecycleIntro =
  "One message, followed from the contact form of a pottery studio to the studio's email, or to the folder where it waits for a decision.";

const visitorIsAnswered = "Your site gets its answer once Rondyr has saved the message";
const analysisScores =
  "Jev, a classifier model on Workers AI, scores the message for spam, for sales outreach and for relevance to your business.";

export const lifecycleSteps: readonly LifecycleStep[] = [
  {
    id: "create",
    caption: {
      title: "Create a form and describe your business",
      text: "A form needs a name, and one or two sentences about what you do. The AI analysis reads that description later, to tell a customer's question from a message that has nothing to do with you.",
    },
  },
  {
    id: "connect",
    caption: {
      title: "Paste the address into your form",
      text: "Rondyr gives the form a submission address that never changes. Put it in the action attribute of an HTML form on any site, or send JSON to it with fetch.",
    },
  },
  {
    id: "submit",
    caption: {
      review: {
        title: "A visitor sends a message",
        text: `This one is from Sam, who sells lead generation to ceramics studios and pitches it through the studio's contact form. ${visitorIsAnswered}, so Sam sees the thank-you page like any other visitor.`,
      },
      accepted: {
        title: "A visitor sends a message",
        text: `This one is from Ruth, who wants to book the Saturday wheel-throwing class for two. ${visitorIsAnswered}, so Ruth sees the thank-you page before the AI analysis has run.`,
      },
    },
  },
  {
    id: "reception",
    caption: {
      title: "Reception checks",
      text: "Rondyr checks the message as it arrives, without a model: the site it comes from, the hidden honeypot field, Turnstile, repeated messages, blocked words and the daily limit. None of them stops this message, so it goes to the AI analysis.",
    },
  },
  {
    id: "analysis",
    caption: {
      review: {
        title: "AI analysis",
        text: `${analysisScores} Sam's message isn't spam and it is about ceramics, but it scores 93% for sales outreach, and a message above 50% goes to review.`,
      },
      accepted: {
        title: "AI analysis",
        text: `${analysisScores} Ruth's message scores 2% for spam and 3% for sales outreach, and it is 98% relevant to a pottery studio. No rule sends it to review, so Rondyr accepts it.`,
      },
    },
  },
  {
    id: "outcome",
    caption: {
      review: {
        title: "To review",
        text: "Rondyr doesn't delete a message it doubts. This one waits in To review with its reason until you archive it, or accept it and send it to your email, webhook or connector.",
      },
      accepted: {
        title: "Accepted and delivered",
        text: "Nobody has to open the dashboard for this one. Rondyr sends it to the destinations of the form, here the studio's email address and a webhook, and tries again when a delivery fails.",
      },
    },
  },
];

/** The steps as a Markdown list, with one item a message where the messages differ. */
export function lifecycleMarkdown(): readonly string[] {
  return lifecycleSteps.flatMap(({ caption }, index) => {
    const number = `${index + 1}.`;
    if ("title" in caption) return [`${number} **${caption.title}.** ${caption.text}`];
    const each = messages.map(({ id, kind }) => ({ kind, ...caption[id] }));
    const [first] = each;
    if (first === undefined) return [];
    return each.every(({ title }) => title === first.title)
      ? [`${number} **${first.title}.**`, ...each.map(({ kind, text }) => `   - ${kind}: ${text}`)]
      : [
          `${number} One of ${each.length} outcomes.`,
          ...each.map(({ kind, title, text }) => `   - ${kind}: **${title}.** ${text}`),
        ];
  });
}

const { inbox, status, verification } = english;
const { checks, verdicts } = verification;
const salesOutreach = status.reasons.solicitation;
const jev = inbox.policy.models.jev;
const [review] = messages;

/**
 * The texts of the dashboard that its excerpts show, read from its English locale so an
 * excerpt says what the dashboard says. The type check fails on a key the locale no longer has.
 */
export const dashboardText = {
  forms: inbox.sections.forms,
  formPage: {
    // The page of a form that has no name yet.
    newTitle: inbox.forms.newTitle,
    name: inbox.forms.name,
    business: inbox.business.label,
    businessPlaceholder: inbox.forms.businessPlaceholder,
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
    model: jev,
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
    verdicts: {
      review: {
        title: fill(verdicts.solicitation, { score: percent(review.scores.solicitation) }),
        detail: fill(verdicts.aboveThreshold, {
          threshold: percent(story.thresholds.solicitation),
        }),
      },
      accepted: {
        title: fill(verdicts.acceptedAutomatic, { classifier: jev }),
        detail: verdicts.nothingFired,
      },
    },
    spam: checks.spam.name,
    solicitation: checks.solicitation.name,
    relevance: checks.relevance.name,
  },
  outcome: {
    review: {
      sent: fill(verification.timeline.quarantined, { reason: salesOutreach }),
      folder: inbox.folders.quarantined,
      reason: salesOutreach,
      archive: inbox.reader.archive,
      accept: inbox.reader.accept,
      acceptAndSend: inbox.reader.acceptAndSend,
    },
    accepted: {
      sent: fill(verification.timeline.acceptedAutomatic, { classifier: jev }),
      folder: inbox.folders.accepted,
      deliveries: inbox.deliveries.title,
      refresh: inbox.deliveries.refresh,
      email: fill(inbox.deliveries.email, { recipients: story.destinations.email }),
      // The locale writes the address of a webhook in a <code> element after this word.
      webhook: inbox.deliveries.webhook.slice(0, inbox.deliveries.webhook.indexOf("<")).trim(),
      sending: status.deliveries.processing,
      delivered: status.deliveries.delivered,
    },
  },
} as const;
