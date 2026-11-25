import { cn } from "cn";
import {
  Ban,
  EyeOff,
  Gauge,
  MailQuestionMark,
  MailWarning,
  Megaphone,
  Repeat2,
  ScanText,
  Shield,
  Target,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import type { QuarantineReason } from "@rondyr/contracts/classification";

type Reason = typeof QuarantineReason.Type;

/**
 * One icon for each reason a message goes to review, and for the Off-topic label. The
 * list, the reader and the screening table show the same icon beside the same words.
 */
export const reasonIcons = {
  "probable-spam": MailWarning,
  ambiguous: MailQuestionMark,
  solicitation: Megaphone,
  "low-relevance": Target,
  "classification-error": ScanText,
  honeypot: EyeOff,
  repetition: Repeat2,
  "turnstile-failed": Shield,
  "blocked-term": Ban,
  quota: Gauge,
  "off-topic": Target,
} as const satisfies Record<Reason | "off-topic", LucideIcon>;

interface ReasonLabelProps {
  readonly reason: Reason | "off-topic";
  readonly className?: string;
}

/** Why a message went to review, or its Off-topic label: an icon and the words. */
export function ReasonLabel({ reason, className }: ReasonLabelProps) {
  const { t } = useTranslation();
  const Icon = reasonIcons[reason];
  return (
    <span className={cn("inline-flex items-baseline gap-1", className)}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0 self-center" />
      <span>
        {reason === "off-topic" ? t("inbox.offTopicLabel") : t(`status.reasons.${reason}`)}
      </span>
    </span>
  );
}
