/**
 * The pre-purchase disclosure list (audit item L11).
 *
 * This lives outside `*.server.ts` because the settings screen renders the list.
 * It is pure data: no fetch, no database, no secrets.
 */

/** The ten disclosures, by key. Kept as a union so the settings form cannot drift. */
export type PolicyKey =
  | "returnPolicy"
  | "refundPolicy"
  | "exchangePolicy"
  | "warrantyPolicy"
  | "deliveryTerms"
  | "returnShippingCost"
  | "paymentModes"
  | "grievanceRedressal"
  | "otherInformation"
  | "useBeforeInfo";

/** The disclosure list, in the order the settings screen shows it. */
export interface PolicyFieldSpec {
  key: PolicyKey;
  label: string;
  description: string;
  /** False for the item the audit describes as applying "where relevant". */
  required: boolean;
}

export const POLICY_FIELDS: readonly PolicyFieldSpec[] = [
  { key: "returnPolicy", label: "Return policy", description: "Link to your returns page, or write the terms here.", required: true },
  { key: "refundPolicy", label: "Refund policy", description: "When and how refunds are paid.", required: true },
  { key: "exchangePolicy", label: "Exchange policy", description: "What can be exchanged and within how many days.", required: true },
  {
    key: "warrantyPolicy",
    label: "Warranty and guarantee",
    description: "Warranty or guarantee period and how a claim is made.",
    required: true,
  },
  {
    key: "deliveryTerms",
    label: "Delivery and shipment",
    description: "Dispatch time, delivery window and courier terms.",
    required: true,
  },
  {
    key: "paymentModes",
    label: "Modes of payment",
    description: "The payment methods your store accepts.",
    required: true,
  },
  {
    key: "grievanceRedressal",
    label: "Grievance-redressal information",
    description: "How a complaint is made and how it is handled. The grievance officer block shows the officer's details.",
    required: true,
  },
  {
    key: "otherInformation",
    label: "Other pre-purchase information",
    description: "Anything else a shopper needs to make an informed decision, for example country of origin or care instructions.",
    required: true,
  },
  {
    key: "returnShippingCost",
    label: "Return shipping cost",
    description: "Who pays return shipping, and how much. This is the item merchants usually miss.",
    required: true,
  },
  {
    key: "useBeforeInfo",
    label: "Best-before or use-before information",
    description: "Only where the seller is required to publish it for the product being sold.",
    required: false,
  },
];
