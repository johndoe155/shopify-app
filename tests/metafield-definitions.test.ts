/**
 * PUBLIC_READ used to be set only when a definition was created, so a definition
 * that already existed kept Storefront API access off. That is what left
 * legal_in.country_of_origin unreadable for a Search & Discovery filter.
 */
import { describe, expect, it } from "vitest";
import { DEFINITION_SPECS, ensureMetafieldDefinitions } from "~/services/metafield-definitions.server";

type Call = { query: string; variables: Record<string, unknown> };

function fakeAdmin(existing: Record<string, "PUBLIC_READ" | "NONE">, shopExisting: Record<string, "PUBLIC_READ" | "NONE"> = {}) {
  const calls: Call[] = [];
  const respond = (data: unknown) => ({ json: async () => data }) as unknown as Response;
  return {
    calls,
    graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
      const variables = options?.variables ?? {};
      calls.push({ query, variables });
      if (query.includes("LegalDefinitions")) {
        const source = variables.ownerType === "SHOP" ? shopExisting : existing;
        return respond({
          data: {
            metafieldDefinitions: {
              edges: Object.entries(source).map(([key, storefront]) => ({
                node: { key, namespace: "legal_in", access: { storefront } },
              })),
            },
          },
        });
      }
      if (query.includes("UpdateMetafieldDefinition")) {
        return respond({ data: { metafieldDefinitionUpdate: { userErrors: [] } } });
      }
      return respond({ data: { metafieldDefinitionCreate: { userErrors: [] } } });
    },
  };
}

describe("ensureMetafieldDefinitions", () => {
  it("switches Storefront API access on for an existing definition that has it off", async () => {
    const admin = fakeAdmin({ country_of_origin: "NONE", mrp: "PUBLIC_READ" });
    const result = await ensureMetafieldDefinitions(admin);

    expect(result.updated).toEqual(["country_of_origin"]);
    const updates = admin.calls.filter((call) => call.query.includes("UpdateMetafieldDefinition"));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.variables.definition).toEqual({
      namespace: "legal_in",
      key: "country_of_origin",
      ownerType: "PRODUCT",
      access: { storefront: "PUBLIC_READ" },
    });
  });

  it("does not touch a definition that is already public, and still creates the missing ones", async () => {
    const admin = fakeAdmin({ mrp: "PUBLIC_READ" });
    const result = await ensureMetafieldDefinitions(admin);

    expect(result.updated).toEqual([]);
    expect(result.existing).toEqual(["mrp"]);
    expect(result.created).toHaveLength(DEFINITION_SPECS.length - 1);
    expect(admin.calls.some((call) => call.query.includes("UpdateMetafieldDefinition"))).toBe(false);
  });
});
