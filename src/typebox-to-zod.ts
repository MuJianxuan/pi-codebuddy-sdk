// Narrow JSON Schema/TypeBox -> Zod bridge used by the MCP adapter.
// Unsupported schema constructs fail explicitly so an extension tool is
// isolated instead of being silently downgraded to z.unknown().

import { z } from "zod";

type JsonSchema = Record<string, unknown>;
type JsonLiteral = string | number | boolean | null;

export interface SchemaConversionFailure {
	path: string;
	keyword: string;
	message: string;
}

export class SchemaConversionError extends Error {
	readonly failure: SchemaConversionFailure;

	constructor(failure: SchemaConversionFailure) {
		super(`${failure.path}: unsupported or invalid ${failure.keyword} (${failure.message})`);
		this.name = "SchemaConversionError";
		this.failure = failure;
	}
}

export interface SafeSchemaConversion {
	schema?: z.ZodTypeAny;
	error?: SchemaConversionFailure;
}

const ALLOWED_KEYWORDS = new Set([
	"type", "properties", "patternProperties", "required", "additionalProperties", "items",
	"enum", "const", "oneOf", "anyOf", "allOf", "nullable", "description",
	"title", "default", "examples", "$schema",
	"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
	"minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems",
]);

function isPlainObject(value: unknown): value is JsonSchema {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isJsonLiteral(value: unknown): value is JsonLiteral {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function fail(path: string, keyword: string, message: string): never {
	throw new SchemaConversionError({ path, keyword, message });
}

function schemaObject(value: unknown, path: string): JsonSchema {
	if (!isPlainObject(value)) fail(path, "schema", "expected a plain object");
	for (const key of Object.keys(value)) {
		if (!ALLOWED_KEYWORDS.has(key)) fail(path, key, "keyword is outside the supported MCP subset");
	}
	return value;
}

function literalSchema(value: unknown, path: string): z.ZodTypeAny {
	if (!isJsonLiteral(value)) fail(path, "const/enum", "only JSON literals are supported");
	return z.literal(value);
}

function unionSchema(schemas: z.ZodTypeAny[], path: string): z.ZodTypeAny {
	if (schemas.length === 0) fail(path, "enum/union", "empty unions are unsupported");
	if (schemas.length === 1) return schemas[0];
	return z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

function applyValidation(schema: z.ZodTypeAny, prop: JsonSchema, path: string, kind: string): z.ZodTypeAny {
	let result = schema;
	const numberSchema = kind === "number" || kind === "integer";
	if (numberSchema) {
		if (typeof prop.minimum === "number") result = (result as z.ZodNumber).min(prop.minimum);
		if (typeof prop.maximum === "number") result = (result as z.ZodNumber).max(prop.maximum);
		if (typeof prop.exclusiveMinimum === "number") result = (result as z.ZodNumber).gt(prop.exclusiveMinimum);
		if (typeof prop.exclusiveMaximum === "number") result = (result as z.ZodNumber).lt(prop.exclusiveMaximum);
		if (typeof prop.multipleOf === "number" && prop.multipleOf > 0) {
			const multiple = prop.multipleOf;
			result = result.refine((value) => Math.abs(Number(value) / multiple - Math.round(Number(value) / multiple)) < Number.EPSILON, {
				message: `must be a multiple of ${multiple}`,
			});
		}
		for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
			if (prop[key] !== undefined && typeof prop[key] !== "number") fail(path, key, "expected a finite number");
		}
	}
	if (kind === "string") {
		if (typeof prop.minLength === "number") result = (result as z.ZodString).min(prop.minLength);
		if (typeof prop.maxLength === "number") result = (result as z.ZodString).max(prop.maxLength);
		if (typeof prop.pattern === "string") {
			try {
				result = (result as z.ZodString).regex(new RegExp(prop.pattern));
			} catch {
				fail(path, "pattern", "invalid regular expression");
			}
		}
		for (const key of ["minLength", "maxLength"]) {
			if (prop[key] !== undefined && (typeof prop[key] !== "number" || !Number.isInteger(prop[key]) || prop[key] < 0)) {
				fail(path, key, "expected a non-negative integer");
			}
		}
	}
	if (kind === "array") {
		if (typeof prop.minItems === "number") result = (result as z.ZodArray<any>).min(prop.minItems);
		if (typeof prop.maxItems === "number") result = (result as z.ZodArray<any>).max(prop.maxItems);
		if (prop.uniqueItems === true) {
			result = result.refine((items) => {
				if (!Array.isArray(items)) return true;
				const serialized = items.map((item) => JSON.stringify(item));
				return new Set(serialized).size === serialized.length;
			}, { message: "items must be unique" });
		} else if (prop.uniqueItems !== undefined && prop.uniqueItems !== false) {
			fail(path, "uniqueItems", "expected a boolean");
		}
		for (const key of ["minItems", "maxItems"]) {
			if (prop[key] !== undefined && (typeof prop[key] !== "number" || !Number.isInteger(prop[key]) || prop[key] < 0)) {
				fail(path, key, "expected a non-negative integer");
			}
		}
	}
	if (typeof prop.nullable !== "undefined" && typeof prop.nullable !== "boolean") fail(path, "nullable", "expected a boolean");
	if (prop.nullable === true) result = result.nullable();
	if (typeof prop.description === "string") result = result.describe(prop.description);
	return result;
}

function objectSchema(prop: JsonSchema, path: string, relax: boolean): z.ZodTypeAny {
	const shape = jsonSchemaToZodShape(prop, path, relax);
	const patternProperties = prop.patternProperties;
	if (patternProperties !== undefined && !isPlainObject(patternProperties)) {
		fail(`${path}.patternProperties`, "patternProperties", "expected an object of regular expressions to schemas");
	}
	const patternEntries = Object.entries((patternProperties as JsonSchema | undefined) ?? {});
	let patternSchema: z.ZodTypeAny | undefined;
	for (const [pattern, schema] of patternEntries) {
		try {
			new RegExp(pattern);
		} catch {
			fail(`${path}.patternProperties.${pattern}`, "patternProperties", "invalid regular expression");
		}
		if (pattern !== "^.*$" && pattern !== ".*") {
			fail(`${path}.patternProperties.${pattern}`, "patternProperties", "only catch-all patterns are supported");
		}
		if (patternSchema) {
			fail(`${path}.patternProperties`, "patternProperties", "multiple catch-all patterns are unsupported");
		}
		patternSchema = jsonSchemaPropertyToZodInternal(schema, `${path}.patternProperties.${pattern}`, relax);
	}
	const additional = prop.additionalProperties;
	if (additional !== undefined && additional !== true && additional !== false && !isPlainObject(additional)) {
		fail(`${path}.additionalProperties`, "additionalProperties", "expected boolean or schema");
	}
	if (patternSchema && isPlainObject(additional)) {
		fail(`${path}.additionalProperties`, "additionalProperties", "cannot combine a catch-all pattern with an additional-properties schema");
	}
	const additionalSchema = isPlainObject(additional)
		? jsonSchemaPropertyToZodInternal(additional, `${path}.additionalProperties`, relax)
		: undefined;
	const base = z.object(shape);
	if (patternSchema) return base.catchall(patternSchema);
	if (relax) return additionalSchema ? base.catchall(additionalSchema) : base.passthrough();
	if (additional === false) return base.strict();
	if (additionalSchema) return base.catchall(additionalSchema);
	if (additional === true || Object.keys(shape).length === 0) return base.passthrough();
	return base.passthrough();
}

function jsonSchemaPropertyToZodInternal(propValue: unknown, path: string, relax: boolean): z.ZodTypeAny {
	const prop = schemaObject(propValue, path);
	// JSON Schema's empty schema accepts every JSON value. TypeBox emits this
	// shape for Type.Any(), including values inside Record schemas.
	if (Object.keys(prop).length === 0) return z.unknown();
	if (prop.const !== undefined) return applyValidation(literalSchema(prop.const, `${path}.const`), prop, path, "literal");
	if (prop.enum !== undefined) {
		if (!Array.isArray(prop.enum) || prop.enum.length === 0) fail(`${path}.enum`, "enum", "enum must contain at least one literal");
		return applyValidation(unionSchema(prop.enum.map((value, index) => literalSchema(value, `${path}.enum[${index}]`)), path), prop, path, "literal");
	}
	for (const keyword of ["oneOf", "anyOf", "allOf"]) {
		if (prop[keyword] === undefined) continue;
		if (!Array.isArray(prop[keyword]) || prop[keyword].length === 0) fail(`${path}.${keyword}`, keyword, "expected a non-empty schema array");
		const parts = prop[keyword].map((part, index) => jsonSchemaPropertyToZodInternal(part, `${path}.${keyword}[${index}]`, relax));
		const combined = keyword === "allOf"
			? parts.slice(1).reduce((left, right) => z.intersection(left, right), parts[0])
			: unionSchema(parts, `${path}.${keyword}`);
		return applyValidation(combined, prop, path, "union");
	}
	if (Array.isArray(prop.type)) {
		if (prop.type.length === 0 || prop.type.some((value) => typeof value !== "string")) fail(`${path}.type`, "type", "expected non-empty string array");
		return applyValidation(
			unionSchema(prop.type.map((type) => jsonSchemaPropertyToZodInternal({ ...prop, type }, path, relax)), path),
			prop,
			path,
			"union",
		);
	}

	const type = typeof prop.type === "string"
		? prop.type
		: prop.properties !== undefined || prop.patternProperties !== undefined
			? "object"
			: undefined;
	if (!type) fail(path, "type", "schema must declare a supported type");
	switch (type) {
		case "string":
			return applyValidation(z.string(), prop, path, type);
		case "number":
			return applyValidation(z.number(), prop, path, type);
		case "integer":
			return applyValidation(z.number().int(), prop, path, type);
		case "boolean":
			return applyValidation(z.boolean(), prop, path, type);
		case "null":
			return applyValidation(z.null(), prop, path, type);
		case "array": {
			if (prop.items === undefined) return applyValidation(z.array(z.unknown()), prop, path, type);
			if (Array.isArray(prop.items)) fail(`${path}.items`, "items", "tuple arrays are unsupported; use a homogeneous items schema");
			return applyValidation(z.array(jsonSchemaPropertyToZodInternal(prop.items, `${path}.items`, relax)), prop, path, type);
		}
		case "object":
			return applyValidation(objectSchema(prop, path, relax), prop, path, type);
		default:
			fail(`${path}.type`, "type", `unsupported type ${JSON.stringify(type)}`);
	}
}

export function jsonSchemaPropertyToZod(prop: JsonSchema, relax = false): z.ZodTypeAny {
	return jsonSchemaPropertyToZodInternal(prop, "$", relax);
}

export function jsonSchemaToZodShape(schema: unknown, relax?: boolean): Record<string, z.ZodTypeAny>;
export function jsonSchemaToZodShape(schema: unknown, path: string, relax?: boolean): Record<string, z.ZodTypeAny>;
export function jsonSchemaToZodShape(schema: unknown, pathOrRelax: string | boolean = "$", relax = false): Record<string, z.ZodTypeAny> {
	const path = typeof pathOrRelax === "string" ? pathOrRelax : "$";
	const actualRelax = typeof pathOrRelax === "boolean" ? pathOrRelax : relax;
	const s = schemaObject(schema, path);
	const parts: JsonSchema[] = [s];
	if (s.allOf !== undefined) {
		if (!Array.isArray(s.allOf)) fail(`${path}.allOf`, "allOf", "expected an array");
		for (const [index, part] of s.allOf.entries()) parts.push(schemaObject(part, `${path}.allOf[${index}]`));
	}
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [partIndex, part] of parts.entries()) {
		if (part.properties === undefined) continue;
		if (!isPlainObject(part.properties)) fail(`${path}${partIndex === 0 ? "" : `.allOf[${partIndex - 1}]`}.properties`, "properties", "expected an object");
		const requiredValue = part.required;
		if (requiredValue !== undefined && (!Array.isArray(requiredValue) || requiredValue.some((key) => typeof key !== "string"))) {
			fail(`${path}.required`, "required", "expected an array of property names");
		}
		const required = new Set((requiredValue as string[] | undefined) ?? []);
		for (const [key, prop] of Object.entries(part.properties)) {
			const converted = jsonSchemaPropertyToZodInternal(prop, `${path}.properties.${key}`, actualRelax);
			shape[key] = actualRelax || !required.has(key) ? converted.optional() : converted;
		}
	}
	return shape;
}

export function jsonSchemaToZodObject(schema: unknown, relax = false): z.ZodTypeAny {
	return jsonSchemaPropertyToZodInternal(schema, "$", relax);
}

export function tryJsonSchemaToZodObjectForMcp(schema: unknown): SafeSchemaConversion {
	try {
		return { schema: jsonSchemaToZodObjectForMcp(schema) };
	} catch (error) {
		if (error instanceof SchemaConversionError) return { error: error.failure };
		return { error: { path: "$", keyword: "schema", message: error instanceof Error ? error.message : String(error) } };
	}
}

export function jsonSchemaToZodObjectForMcp(schema: unknown): z.ZodTypeAny {
	const value = schemaObject(schema, "$");
	return jsonSchemaPropertyToZodInternal(value, "$", false);
}
