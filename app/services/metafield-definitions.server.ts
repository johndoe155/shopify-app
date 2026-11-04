/**
 * Creates the `legal_in.*` metafield definitions (plus the JSON prior-price and
 * shop-settings definitions) on install. Idempotent: a definition that already
 * exists is not recreated, so re-runs and reinstalls are safe. An existing one
 * is only touched to switch Storefront API access on when it is off.
 *
 * The key set follows the audit: manufacturer, packer, importer and seller are
 * separate (L4); canonical country and label wording are separate (L5); the
 * imported-package flag is explicit (L6); manufacture and best-before/use-by are
 * separate (L9); the common name carries label evidence (L8); unit sale price is
 * its own declaration (L1); and the unit choice list includes cm and the count
 * descriptors (L7).
 */
import { NET_QUANTITY_UNITS } from "~/domain/types";
import { LEGAL_NAMESPACE, LEGAL_METAFIELD_KEYS, METAFIELD_TYPES, PRIOR_PRICE_KEY, SHOP_SETTINGS_KEY } from "./ports";

export interface DefinitionSpec {
  key: string;
  name: string;
  description: string;
  type: string;
  ownerType: "PRODUCT" | "SHOP";
  validations?: Array<{ name: string; value: string }>;
}

const LEGAL_DEFINITION_META: Record<
  (typeof LEGAL_METAFIELD_KEYS)[number],
  { name: string; description: string; validations?: Array<{ name: string; value: string }> }
> = {
  mrp: {
    name: "MRP (inclusive of all taxes)",
    description:
      "Retail sale price printed on the pack, inclusive of all taxes. Rule 2(m) and Rule 6(1)(e).",
  },
  variant_mrp: {
    name: "MRP per variant (separate packages)",
    description:
      "JSON map of variant id to the price declared for that package, where a variant is a separately priced package. One MRP is not applied to every variant.",
  },
  manufacturer_name: {
    name: "Manufacturer name",
    description: "Name of the manufacturer as printed on the pack. Rule 6(1)(a).",
  },
  manufacturer_address: {
    name: "Manufacturer address",
    description: "Full address of the manufacturer as printed on the pack. Rule 6(1)(a).",
  },
  packer_differs_from_manufacturer: {
    name: "Packer is a different person from the manufacturer",
    description:
      "Where the packer is not the manufacturer, the package must identify both. Rule 6(1)(a).",
  },
  packer_name: {
    name: "Packer name",
    description: "Name of the packer, where the packer is not the manufacturer.",
  },
  packer_address: {
    name: "Packer address",
    description: "Full address of the packer, where the packer is not the manufacturer.",
  },
  seller_name: {
    name: "Seller / dealer name",
    description: "Dealer or seller data where the package carries it.",
  },
  seller_address: {
    name: "Seller / dealer address",
    description: "Dealer or seller address where the package carries it.",
  },
  country_of_origin: {
    name: "Country of origin (canonical)",
    description:
      "Canonical country of origin, for example India. The country list is an app convenience, not a statutory format.",
  },
  country_of_origin_label: {
    name: "Country of origin as printed on the pack",
    description:
      "The exact wording on the package or label, for example 'Made in India'. Stored as label evidence next to the canonical country.",
  },
  is_imported_package: {
    name: "Imported package",
    description:
      "Whether this is an imported package. Importer details are required for imported packages; country of origin is only a proxy.",
  },
  importer_name: {
    name: "Importer name",
    description: "Name of the importer in India, required for an imported package.",
  },
  importer_address: {
    name: "Importer address",
    description: "Full address of the importer, required for an imported package.",
  },
  package_type: {
    name: "Package type (scope)",
    description:
      "Scope under Rules 3 and 26: packaged, combination, multi piece, wholesale or excluded. Wholesale and excluded packages are outside the retail declaration checks.",
    validations: [{ name: "choices", value: "packaged,combination,multi_piece,wholesale,excluded" }],
  },
  net_quantity_value: {
    name: "Net quantity (value)",
    description: "Declared net quantity number, for example 100. Rule 6(1)(c).",
  },
  net_quantity_unit: {
    name: "Net quantity (unit)",
    description:
      "Rule 13 unit: g or kg, cm or m, ml or l, or a count descriptor. The standard unit depends on the quantity.",
    validations: [{ name: "choices", value: NET_QUANTITY_UNITS.join(",") }],
  },
  generic_name: {
    name: "Common / generic name",
    description: "Common or generic name of the commodity. Rule 6(1)(b).",
  },
  generic_name_on_label: {
    name: "Common name printed on the pack",
    description:
      "Confirmation that the common name is printed on the package or label. An online product title is not label evidence.",
  },
  manufactured_date: {
    name: "Month/year of manufacture or pre-packing (MM/YYYY)",
    description:
      "Generally required for a covered package and not switchable off by a merchant flag. Rule 6(1)(d).",
  },
  expiry_type: {
    name: "Best-before / use-by type",
    description:
      "Whether the commodity carries a best-before or use-by date because it may become unfit for human consumption. Rule 6(1)(da).",
    validations: [{ name: "choices", value: "none,best_before,use_by" }],
  },
  expiry_date: {
    name: "Best-before / use-by date (MM/YYYY)",
    description: "The best-before or use-by month and year shown on the pack. Rule 6(1)(da).",
  },
  unit_sale_price: {
    name: "Unit sale price (per standard unit)",
    description:
      "Price per kg, litre, metre or number, rounded to the nearest two decimal places. Rule 6(11).",
  },
};

export const DEFINITION_SPECS: DefinitionSpec[] = [
  ...LEGAL_METAFIELD_KEYS.map((key) => ({
    key,
    name: LEGAL_DEFINITION_META[key].name,
    description: LEGAL_DEFINITION_META[key].description,
    type: METAFIELD_TYPES[key],
    ownerType: "PRODUCT" as const,
    validations: LEGAL_DEFINITION_META[key].validations,
  })),
  {
    key: PRIOR_PRICE_KEY,
    name: "Prior price (30-day history)",
    description:
      "Computed prior price per variant, with the tracking start date. Written by the app for the prior price block.",
    type: "json",
    ownerType: "PRODUCT",
  },
  {
    key: SHOP_SETTINGS_KEY,
    name: "Store legal settings",
    description:
      "Consumer care, grievance officer and policy settings mirrored from the app so storefront blocks need no server call.",
    type: "json",
    ownerType: "SHOP",
  },
];

const CREATE_DEFINITION = `#graphql
  mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id key namespace }
      userErrors { field message code }
    }
  }
`;

const LIST_DEFINITIONS = `#graphql
  query LegalDefinitions($namespace: String!, $ownerType: MetafieldOwnerType!) {
    metafieldDefinitions(first: 50, namespace: $namespace, ownerType: $ownerType) {
      edges { node { key namespace access { storefront } } }
    }
  }
`;

const UPDATE_DEFINITION = `#graphql
  mutation UpdateMetafieldDefinition($definition: MetafieldDefinitionUpdateInput!) {
    metafieldDefinitionUpdate(definition: $definition) {
      updatedDefinition { id key namespace }
      userErrors { field message code }
    }
  }
`;

export interface DefinitionResult {
  created: string[];
  existing: string[];
  /** Existing definitions whose Storefront API access was switched to PUBLIC_READ. */
  updated: string[];
  failed: Array<{ key: string; message: string }>;
}

type GraphQLFetch = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;

/** Existing definition keys, each with whether Storefront API access is already PUBLIC_READ. */
async function existingDefinitions(
  admin: { graphql: GraphQLFetch },
  ownerType: "PRODUCT" | "SHOP",
): Promise<Map<string, boolean>> {
  const response = await admin.graphql(LIST_DEFINITIONS, {
    variables: { namespace: LEGAL_NAMESPACE, ownerType },
  });
  const body = (await response.json()) as {
    data?: {
      metafieldDefinitions?: {
        edges?: Array<{ node: { key: string; access?: { storefront?: string | null } | null } }>;
      };
    };
  };
  const edges = body.data?.metafieldDefinitions?.edges ?? [];
  return new Map(edges.map((edge) => [edge.node.key, edge.node.access?.storefront === "PUBLIC_READ"]));
}

/** Creates only the definitions that do not exist yet. Safe to call on every install. */
export async function ensureMetafieldDefinitions(admin: { graphql: GraphQLFetch }): Promise<DefinitionResult> {
  const result: DefinitionResult = { created: [], existing: [], updated: [], failed: [] };
  const have = {
    PRODUCT: await existingDefinitions(admin, "PRODUCT"),
    SHOP: await existingDefinitions(admin, "SHOP"),
  };

  for (const spec of DEFINITION_SPECS) {
    const publicRead = have[spec.ownerType].get(spec.key);
    if (publicRead !== undefined) {
      result.existing.push(spec.key);
      // PUBLIC_READ was only ever set when a definition was created, so a
      // definition that already existed (created by an import, a script, or an
      // earlier release) kept Storefront API access off, and a Search & Discovery
      // filter on legal_in.country_of_origin could not read it.
      if (!publicRead) {
        const update = await admin.graphql(UPDATE_DEFINITION, {
          variables: {
            definition: {
              namespace: LEGAL_NAMESPACE,
              key: spec.key,
              ownerType: spec.ownerType,
              access: { storefront: "PUBLIC_READ" },
            },
          },
        });
        const updateBody = (await update.json()) as {
          data?: { metafieldDefinitionUpdate?: { userErrors?: Array<{ message: string }> } };
        };
        const updateErrors = updateBody.data?.metafieldDefinitionUpdate?.userErrors ?? [];
        if (updateErrors.length > 0) {
          result.failed.push({ key: spec.key, message: updateErrors.map((e) => e.message).join("; ") });
        } else {
          result.updated.push(spec.key);
        }
      }
      continue;
    }
    const response = await admin.graphql(CREATE_DEFINITION, {
      variables: {
        definition: {
          name: spec.name,
          description: spec.description,
          namespace: LEGAL_NAMESPACE,
          key: spec.key,
          type: spec.type,
          ownerType: spec.ownerType,
          access: { storefront: "PUBLIC_READ" },
          ...(spec.validations ? { validations: spec.validations } : {}),
        },
      },
    });
    const body = (await response.json()) as {
      data?: { metafieldDefinitionCreate?: { userErrors?: Array<{ message: string; code?: string }> } };
    };
    const errors = body.data?.metafieldDefinitionCreate?.userErrors ?? [];
    if (errors.length > 0) {
      const alreadyExists = errors.some((e) => e.code === "TAKEN");
      if (alreadyExists) result.existing.push(spec.key);
      else result.failed.push({ key: spec.key, message: errors.map((e) => e.message).join("; ") });
    } else {
      result.created.push(spec.key);
    }
  }
  return result;
}
