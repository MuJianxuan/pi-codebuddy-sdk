// TypeBox (JSON Schema) → Zod conversion used by buildMcpServers.
//
// Pi tools declare their parameters as TypeBox objects (i.e. JSON Schema at
// runtime). The Agent SDK's createSdkMcpServer requires Zod — its internal
// `Z0()` detects Zod via the `~standard` marker or `_def`/`_zod` properties
// and silently downgrades unrecognized schemas to
// `{type: "object", properties: {}}`, which leaves the model with no
// parameter info. This module bridges the two so MCP-exposed pi tools retain
// their schemas. If this breaks after an SDK update, check whether `Z0()`
// detection changed or createSdkMcpServer now accepts raw JSON Schema.

import { z } from "zod";

type JsonSchema = Record<string, unknown>;
type JsonLiteral = string | number | boolean | null;

function withDescription(schema: z.ZodTypeAny, prop: JsonSchema): z.ZodTypeAny {
	if (typeof prop.description === "string") return schema.describe(prop.description);
	return schema;
}

function isJsonLiteral(value: unknown): value is JsonLiteral {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function literalSchema(value: unknown): z.ZodTypeAny {
	if (
		isJsonLiteral(value)
	) {
		return z.literal(value);
	}
	return z.unknown();
}

function unionSchema(schemas: z.ZodTypeAny[]): z.ZodTypeAny {
	if (schemas.length === 0) return z.unknown();
	if (schemas.length === 1) return schemas[0];
	return z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

function intersectionSchema(schemas: z.ZodTypeAny[]): z.ZodTypeAny {
	if (schemas.length === 0) return z.unknown();
	if (schemas.length === 1) return schemas[0];
	return schemas.slice(1).reduce((left, right) => z.intersection(left, right), schemas[0]);
}

function objectSchema(prop: JsonSchema, relax = false): z.ZodTypeAny {
	const shape = jsonSchemaToZodShape(prop, relax);
	const additionalPropertiesSchema =
		prop.additionalProperties && typeof prop.additionalProperties === "object"
			? jsonSchemaPropertyToZod(prop.additionalProperties as JsonSchema, relax)
			: undefined;
	if (Object.keys(shape).length > 0) {
		const base = z.object(shape);
		// relax: never strict — accept {} and extra keys so a CodeBuddy MCP client
		// that drops parallel tool_call arguments to {} still passes validation.
		if (!relax && prop.additionalProperties === false) return base.strict();
		if (additionalPropertiesSchema) return base.catchall(additionalPropertiesSchema);
		return base.passthrough();
	}
	if (additionalPropertiesSchema) return z.record(z.string(), additionalPropertiesSchema);
	if (!relax && prop.additionalProperties === false) return z.object({}).strict();
	return z.record(z.string(), z.unknown());
}

export function jsonSchemaPropertyToZod(prop: JsonSchema, relax = false): z.ZodTypeAny {
	let base: z.ZodTypeAny;

	if (prop.const !== undefined) {
		base = literalSchema(prop.const);
		if (prop.nullable === true) base = base.nullable();
		return withDescription(base, prop);
	}

	if (Array.isArray(prop.enum)) {
		base = unionSchema(prop.enum.map((value) => literalSchema(value)));
		if (prop.nullable === true) base = base.nullable();
		return withDescription(base, prop);
	}

	if (Array.isArray(prop.oneOf)) {
		base = unionSchema(prop.oneOf.map((item) => jsonSchemaPropertyToZod(item as JsonSchema)));
		if (prop.nullable === true) base = base.nullable();
		return withDescription(base, prop);
	}

	if (Array.isArray(prop.anyOf)) {
		base = unionSchema(prop.anyOf.map((item) => jsonSchemaPropertyToZod(item as JsonSchema)));
		if (prop.nullable === true) base = base.nullable();
		return withDescription(base, prop);
	}

	if (Array.isArray(prop.allOf)) {
		base = intersectionSchema(prop.allOf.map((item) => jsonSchemaPropertyToZod(item as JsonSchema)));
		if (prop.nullable === true) base = base.nullable();
		return withDescription(base, prop);
	}

	if (Array.isArray(prop.type)) {
		const allowsNull = prop.type.includes("null");
		const schemas = prop.type
			.filter((value): value is string => typeof value === "string" && value !== "null")
			.map((value) => jsonSchemaPropertyToZod({ ...prop, type: value, nullable: false }));
		base = unionSchema(schemas);
		base = allowsNull ? base.nullable() : base;
		return withDescription(base, prop);
	}

	const propType = typeof prop.type === "string" ? prop.type : undefined;
	switch (propType) {
		case "string":
			base = z.string();
			break;
		case "number":
		case "integer":
			base = z.number();
			break;
		case "boolean":
			base = z.boolean();
			break;
		case "array":
			base = prop.items
				? z.array(jsonSchemaPropertyToZod(prop.items as JsonSchema))
				: z.array(z.unknown());
			break;
		case "object":
			base = objectSchema(prop, relax);
			break;
		case "null":
			base = z.null();
			break;
		default:
			if (prop.properties) base = objectSchema(prop);
			else base = z.unknown();
	}

	if (prop.nullable === true) base = base.nullable();
	return withDescription(base, prop);
}

export function jsonSchemaToZodShape(schema: unknown, relax = false): Record<string, z.ZodTypeAny> {
	const s = schema as JsonSchema;
	const objectSchemas = [s, ...(Array.isArray(s?.allOf) ? s.allOf as JsonSchema[] : [])]
		.filter((item) => item && typeof item === "object" && ((item as JsonSchema).type === "object" || (item as JsonSchema).properties));
	if (objectSchemas.length === 0) return {};

	const shape: Record<string, z.ZodTypeAny> = {};
	for (const objectSchemaPart of objectSchemas) {
		const props = objectSchemaPart.properties as Record<string, JsonSchema> | undefined;
		if (!props) continue;
		const required = new Set(Array.isArray(objectSchemaPart.required) ? objectSchemaPart.required as string[] : []);
		for (const [key, prop] of Object.entries(props)) {
			const zodProp = jsonSchemaPropertyToZod(prop, relax);
			// relax: make every property optional so an empty {} (args dropped by a
			// buggy parallel tool_call dispatch) still validates. Descriptions are
			// preserved so the model keeps parameter guidance.
			shape[key] = relax || !required.has(key) ? zodProp.optional() : zodProp;
		}
	}
	return shape;
}

export function jsonSchemaToZodObject(schema: unknown, relax = false): z.ZodTypeAny {
	return jsonSchemaPropertyToZod(schema as JsonSchema, relax);
}

/**
 * MCP-specific schema builder: preserves required field constraints so that
 * an empty {} (from a buggy parallel tool_call dispatch) is rejected by MCP
 * validation, while still allowing extra keys (passthrough) for forward-compat.
 *
 * Unlike jsonSchemaToZodObject(relax=true) which makes ALL params optional,
 * this keeps required params required. This forces CodeBuddy to regenerate
 * proper args instead of silently passing {} through to the handler.
 *
 * The deferred-backfill logic in processStreamEvent/processAssistantMessage
 * handles the case where stream args arrive empty — it waits for the
 * assistant message or MCP dispatch to provide real args. So MCP validation
 * rejecting {} is safe and desirable: it's an early signal that args were
 * dropped, rather than letting an empty-args call reach pi.
 */
export function jsonSchemaToZodObjectForMcp(schema: unknown): z.ZodTypeAny {
	const s = schema as JsonSchema;
	// Build shape with relax=false to preserve required constraints
	const shape = jsonSchemaToZodShape(s, false);
	const additionalPropertiesSchema =
		s?.additionalProperties && typeof s.additionalProperties === "object"
			? jsonSchemaPropertyToZod(s.additionalProperties as JsonSchema, false)
			: undefined;

	if (Object.keys(shape).length > 0) {
		const base = z.object(shape);
		// Always passthrough: accept extra keys (forward-compat with new params)
		// but enforce required fields.
		if (additionalPropertiesSchema) return base.catchall(additionalPropertiesSchema);
		return base.passthrough();
	}
	if (s?.additionalProperties === false) return z.object({}).strict();
	return z.record(z.string(), z.unknown());
}
