import { Schema } from "effect";

export const maxOrganizationDomains = 10;

const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const hostname = new RegExp(`^${label}(?:\\.${label})+$`, "u");
const numericLastLabel = /\.\d+$/u;

export const OrganizationDomain = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.makeFilter(
    (domain) =>
      (hostname.test(domain) && !numericLastLabel.test(domain)) ||
      "Expected a lowercase ASCII hostname such as example.com",
  ),
).pipe(Schema.brand("OrganizationDomain"));
export type OrganizationDomain = typeof OrganizationDomain.Type;

export const OrganizationDomainList = Schema.Array(OrganizationDomain).check(
  Schema.isMaxLength(maxOrganizationDomains),
  Schema.makeFilter(
    (domains) => new Set(domains).size === domains.length || "Expected distinct domains",
  ),
);
export type OrganizationDomainList = typeof OrganizationDomainList.Type;

export const OrganizationDomainInput = Schema.Struct({ domain: OrganizationDomain });

export const DomainRequestError = Schema.Struct({
  error: Schema.Literals(["invalid-domain", "domain-limit"]),
});
