import { Schema } from "effect";

import { EmailRecipients } from "../../domain/deliveries/email.ts";

/** `notification_targets.configuration` of a target of type `email`. */
export const EmailConfiguration = Schema.Struct({ recipients: EmailRecipients });
