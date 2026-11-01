/**
 * F6 — store settings: the package-label contact, the platform customer-care
 * surface, the grievance officer and the pre-purchase disclosures.
 *
 * Saved to Postgres and mirrored to the shop-level `legal_in.settings` JSON
 * metafield so the storefront blocks render without calling this server.
 *
 * Two audit findings shape this file:
 *  - L10: Rule 6(2) (package-label contact) and the 2020 E-Commerce Rules
 *    (platform customer care) are separate regimes. The old form conflated them
 *    and had no address field at all.
 *  - L11: the disclosure list was six items; it is now the full set the 2020
 *    Rules require, including modes of payment, grievance-redressal information,
 *    other pre-purchase information and best-before/use-before information.
 */
import { validateEmail, validatePhone, validatePolicyLink, sanitizeText, sanitizeMultilineText } from "~/domain/validation";
import type { FieldError } from "~/domain/validation";
import type { Repository } from "~/db/repository";
import type { ShopRecord, ShopSettingsPatch } from "~/db/types";
import type { PolicyLinkCheck } from "~/domain/types";
import { LEGAL_NAMESPACE, SHOP_SETTINGS_KEY, type MetafieldWriter } from "./ports";
import { POLICY_FIELDS } from "~/domain/policies";
import { resolvePolicyUrl } from "./policy-links.server";

export { POLICY_FIELDS } from "~/domain/policies";
export type { PolicyFieldSpec, PolicyKey } from "~/domain/policies";

export interface ShopSettingsInput {
  /** Rule 6(2): name of the person or office contactable for complaints. */
  storeName: string;
  consumerCareAddress: string;
  consumerCarePhone: string;
  consumerCareEmail: string;
  /** 2020 Rules, Rule 4(2)(d): the e-commerce entity's customer-care surface. */
  platformCustomerCareUrl: string;
  grievanceName: string;
  grievanceDesignation: string;
  grievanceEmail: string;
  grievancePhone: string;
  returnPolicyUrl: string;
  returnPolicyText: string;
  refundPolicyUrl: string;
  refundPolicyText: string;
  exchangePolicyUrl: string;
  exchangePolicyText: string;
  warrantyPolicyUrl: string;
  warrantyPolicyText: string;
  deliveryTermsUrl: string;
  deliveryTermsText: string;
  returnShippingCostUrl: string;
  returnShippingCostText: string;
  paymentModesUrl: string;
  paymentModesText: string;
  grievanceRedressalUrl: string;
  grievanceRedressalText: string;
  otherInformationUrl: string;
  otherInformationText: string;
  useBeforeInfoUrl: string;
  useBeforeInfoText: string;
  confirmDeclarationsBlock: boolean;
  confirmGrievanceBlock: boolean;
  confirmPriorPriceBlock: boolean;
}

export function validateShopSettings(
  input: ShopSettingsInput,
): { patch: ShopSettingsPatch; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const patch: ShopSettingsPatch = {};

  const text = (value: string, max = 500) => sanitizeText(value, max);

  patch.storeName = text(input.storeName, 200);
  // Rule 6(2) requires an address, not just a name. It is validated here so the
  // store check reports a complete declaration rather than a partly saved one.
  patch.consumerCareAddress = sanitizeMultilineText(input.consumerCareAddress, 500);
  if (patch.consumerCareAddress === null && input.consumerCareAddress.trim() !== "") {
    errors.push({ field: "consumerCareAddress", message: "Enter a plain address without angle brackets." });
  }

  const phone = validatePhone(input.consumerCarePhone);
  if (!phone.ok) errors.push({ field: "consumerCarePhone", message: phone.error });
  else patch.consumerCarePhone = phone.value;

  const email = validateEmail(input.consumerCareEmail);
  if (!email.ok) errors.push({ field: "consumerCareEmail", message: email.error });
  else patch.consumerCareEmail = email.value;

  const platform = validatePolicyLink(input.platformCustomerCareUrl);
  if (!platform.ok) errors.push({ field: "platformCustomerCareUrl", message: platform.error });
  else patch.platformCustomerCareUrl = platform.value;

  patch.grievanceName = text(input.grievanceName, 200);
  patch.grievanceDesignation = text(input.grievanceDesignation, 200);

  const grievanceEmail = validateEmail(input.grievanceEmail);
  if (!grievanceEmail.ok) errors.push({ field: "grievanceEmail", message: grievanceEmail.error });
  else patch.grievanceEmail = grievanceEmail.value;

  const grievancePhone = validatePhone(input.grievancePhone);
  if (!grievancePhone.ok) errors.push({ field: "grievancePhone", message: grievancePhone.error });
  else patch.grievancePhone = grievancePhone.value;

  for (const field of POLICY_FIELDS) {
    const urlKey = `${field.key}Url` as keyof ShopSettingsPatch;
    const textKey = `${field.key}Text` as keyof ShopSettingsPatch;
    const urlInput = String(input[urlKey as keyof ShopSettingsInput] ?? "");
    const textInput = String(input[textKey as keyof ShopSettingsInput] ?? "");

    const link = validatePolicyLink(urlInput);
    if (!link.ok) errors.push({ field: urlKey as string, message: link.error });
    else (patch as Record<string, unknown>)[urlKey as string] = link.value;

    const body = sanitizeMultilineText(textInput, 1000);
    if (textInput.length > 1000) {
      errors.push({ field: textKey as string, message: `Keep the ${field.label.toLowerCase()} text under 1000 characters.` });
    }
    (patch as Record<string, unknown>)[textKey as string] = body;
  }

  patch.confirmDeclarationsBlock = Boolean(input.confirmDeclarationsBlock);
  patch.confirmGrievanceBlock = Boolean(input.confirmGrievanceBlock);
  patch.confirmPriorPriceBlock = Boolean(input.confirmPriorPriceBlock);

  return { patch, errors };
}

/** Shape the storefront blocks read. Kept deliberately small and stable. */
export interface ShopSettingsMetafield {
  store_name: string | null;
  /** Rule 6(2) package-label contact. */
  consumer_care: { name: string | null; address: string | null; phone: string | null; email: string | null };
  platform_customer_care_url: string | null;
  grievance_officer: {
    name: string | null;
    designation: string | null;
    email: string | null;
    phone: string | null;
  };
  policies: {
    return_policy: { url: string | null; text: string | null };
    refund_policy: { url: string | null; text: string | null };
    exchange_policy: { url: string | null; text: string | null };
    warranty_policy: { url: string | null; text: string | null };
    delivery_terms: { url: string | null; text: string | null };
    return_shipping_cost: { url: string | null; text: string | null };
    payment_modes: { url: string | null; text: string | null };
    grievance_redressal: { url: string | null; text: string | null };
    other_information: { url: string | null; text: string | null };
    use_before_info: { url: string | null; text: string | null };
  };
  /** Labels the storefront needs so the block does not invent legal wording. */
  statements: {
    acknowledgement_hours: number;
    redressal_period: string;
  };
  updated_at: string;
}

export function buildShopSettingsMetafield(shop: ShopRecord, now: Date = new Date()): ShopSettingsMetafield {
  return {
    store_name: shop.storeName,
    consumer_care: {
      name: shop.storeName,
      address: shop.consumerCareAddress,
      phone: shop.consumerCarePhone,
      email: shop.consumerCareEmail,
    },
    platform_customer_care_url: shop.platformCustomerCareUrl,
    grievance_officer: {
      name: shop.grievanceName,
      designation: shop.grievanceDesignation,
      email: shop.grievanceEmail,
      phone: shop.grievancePhone,
    },
    policies: {
      return_policy: { url: shop.returnPolicyUrl, text: shop.returnPolicyText },
      refund_policy: { url: shop.refundPolicyUrl, text: shop.refundPolicyText },
      exchange_policy: { url: shop.exchangePolicyUrl, text: shop.exchangePolicyText },
      warranty_policy: { url: shop.warrantyPolicyUrl, text: shop.warrantyPolicyText },
      delivery_terms: { url: shop.deliveryTermsUrl, text: shop.deliveryTermsText },
      return_shipping_cost: { url: shop.returnShippingCostUrl, text: shop.returnShippingCostText },
      payment_modes: { url: shop.paymentModesUrl, text: shop.paymentModesText },
      grievance_redressal: { url: shop.grievanceRedressalUrl, text: shop.grievanceRedressalText },
      other_information: { url: shop.otherInformationUrl, text: shop.otherInformationText },
      use_before_info: { url: shop.useBeforeInfoUrl, text: shop.useBeforeInfoText },
    },
    statements: { acknowledgement_hours: 48, redressal_period: "one month" },
    updated_at: now.toISOString(),
  };
}

export interface SaveShopSettingsResult {
  shop: ShopRecord;
  errors: FieldError[];
  mirrored: boolean;
  mirrorError: string | null;
}

/**
 * Saves the settings. The policy-link cache is invalidated for any link whose URL
 * changed, so R9 asks for a fresh accessibility check instead of trusting a stale
 * "ok" result.
 */
export async function saveShopSettings(options: {
  shop: ShopRecord;
  repo: Repository;
  writer: MetafieldWriter | null;
  input: ShopSettingsInput;
  now?: Date;
}): Promise<SaveShopSettingsResult> {
  const now = options.now ?? new Date();
  const { patch, errors } = validateShopSettings(options.input);
  if (errors.length > 0) {
    return { shop: options.shop, errors, mirrored: false, mirrorError: null };
  }

  const previousChecks: Record<string, PolicyLinkCheck> = options.shop.policyLinkChecks ?? {};
  const nextChecks: Record<string, PolicyLinkCheck> = { ...previousChecks };
  for (const field of POLICY_FIELDS) {
    const url = (patch as Record<string, unknown>)[`${field.key}Url`] as string | null | undefined;
    const previous = previousChecks[field.key];
    if (!url) {
      delete nextChecks[field.key];
      continue;
    }
    // A stored check records the *resolved* URL (a relative link such as
    // "/policies/refund-policy" was expanded before it was fetched), so the
    // comparison has to resolve the new value the same way. Comparing the raw
    // input against the stored absolute URL never matched for a relative link,
    // and the check was silently dropped on every save.
    const resolved = resolvePolicyUrl(url, options.shop.shopDomain);
    if (!previous || previous.url !== resolved) delete nextChecks[field.key];
  }
  if (JSON.stringify(nextChecks) !== JSON.stringify(previousChecks)) {
    patch.policyLinkChecks = nextChecks;
  }

  const shop = await options.repo.updateShopSettings(options.shop.id, patch);

  let mirrored = false;
  let mirrorError: string | null = null;
  if (options.writer) {
    try {
      const ownerId = await options.writer.shopOwnerId();
      const result = await options.writer.setMetafields([
        {
          ownerId,
          namespace: LEGAL_NAMESPACE,
          key: SHOP_SETTINGS_KEY,
          type: "json",
          value: JSON.stringify(buildShopSettingsMetafield(shop, now)),
        },
      ]);
      mirrored = result.written === 1;
      if (!mirrored) mirrorError = result.errors[0]?.message ?? "The settings were saved but not published.";
    } catch (error) {
      mirrorError = error instanceof Error ? error.message : String(error);
    }
  }
  return { shop, errors: [], mirrored, mirrorError };
}
