import { Schema } from "effect";

import { EmailLanguage, EmailRecipients } from "../../../domain/deliveries/email.ts";

/**
 * `notification_targets.configuration` of a target of type `email`. A target
 * stored before the language setting has no `language`.
 */
export const EmailConfiguration = Schema.Struct({
  recipients: EmailRecipients,
  language: Schema.optionalKey(EmailLanguage),
});
