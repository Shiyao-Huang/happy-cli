import { z } from 'zod';

type JsonSchema = {
    type?: unknown;
    properties?: unknown;
    required?: unknown;
    items?: unknown;
    enum?: unknown;
    anyOf?: unknown;
    oneOf?: unknown;
    description?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getTypeInfo(typeField: unknown): { types: string[]; nullable: boolean } {
    if (typeof typeField === 'string') {
        return {
            types: typeField === 'null' ? [] : [typeField],
            nullable: typeField === 'null',
        };
    }

    if (Array.isArray(typeField)) {
        const types: string[] = [];
        let nullable = false;

        for (const entry of typeField) {
            if (entry === 'null') {
                nullable = true;
                continue;
            }

            if (typeof entry === 'string') {
                types.push(entry);
            }
        }

        return { types, nullable };
    }

    return { types: [], nullable: false };
}

function getRequiredSet(requiredField: unknown): Set<string> {
    if (!Array.isArray(requiredField)) {
        return new Set();
    }

    return new Set(requiredField.filter((key): key is string => typeof key === 'string'));
}

function applyDescription(schema: z.ZodTypeAny, description: unknown): z.ZodTypeAny {
    if (typeof description === 'string' && description.length > 0) {
        return schema.describe(description);
    }

    return schema;
}

function buildUnion(schemas: z.ZodTypeAny[]): z.ZodTypeAny {
    if (schemas.length === 0) {
        return z.any();
    }

    if (schemas.length === 1) {
        return schemas[0];
    }

    let current = z.union([schemas[0], schemas[1]]);
    for (const schema of schemas.slice(2)) {
        current = z.union([current, schema]);
    }

    return current;
}

function buildEnumSchema(values: unknown): z.ZodTypeAny | null {
    if (!Array.isArray(values) || values.length === 0) {
        return null;
    }

    const literals = values
        .filter((value) => ['string', 'number', 'boolean'].includes(typeof value))
        .map((value) => z.literal(value as string | number | boolean));

    if (literals.length === 0) {
        return null;
    }

    return buildUnion(literals);
}

function buildObjectShape(schema: JsonSchema): z.ZodRawShape {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = getRequiredSet(schema.required);

    const shape: z.ZodRawShape = {};
    for (const [key, propertySchema] of Object.entries(properties)) {
        const normalized = buildZodSchema(propertySchema);
        shape[key] = required.has(key) ? normalized : normalized.optional();
    }

    return shape;
}

function buildZodSchema(schema: unknown): z.ZodTypeAny {
    if (!isRecord(schema)) {
        return z.any();
    }

    const normalizedSchema = schema as JsonSchema;

    const enumSchema = buildEnumSchema(normalizedSchema.enum);
    if (enumSchema) {
        return applyDescription(enumSchema, normalizedSchema.description);
    }

    const oneOf = Array.isArray(normalizedSchema.oneOf)
        ? normalizedSchema.oneOf.map((entry) => buildZodSchema(entry))
        : [];
    if (oneOf.length > 0) {
        return applyDescription(buildUnion(oneOf), normalizedSchema.description);
    }

    const anyOf = Array.isArray(normalizedSchema.anyOf)
        ? normalizedSchema.anyOf.map((entry) => buildZodSchema(entry))
        : [];
    if (anyOf.length > 0) {
        return applyDescription(buildUnion(anyOf), normalizedSchema.description);
    }

    const { types, nullable } = getTypeInfo(normalizedSchema.type);
    const primaryType = types[0] ?? (isRecord(normalizedSchema.properties) ? 'object' : undefined);

    let result: z.ZodTypeAny;

    switch (primaryType) {
        case 'string':
            result = z.string();
            break;
        case 'number':
            result = z.number();
            break;
        case 'integer':
            result = z.number().int();
            break;
        case 'boolean':
            result = z.boolean();
            break;
        case 'array': {
            const itemSchema = buildZodSchema(normalizedSchema.items);
            result = z.array(itemSchema);
            break;
        }
        case 'object': {
            const shape = buildObjectShape(normalizedSchema);
            result = z.object(shape);
            break;
        }
        default:
            result = z.any();
            break;
    }

    if (nullable) {
        result = z.union([result, z.null()]);
    }

    return applyDescription(result, normalizedSchema.description);
}

export function buildToolInputShapeFromJsonSchema(schema: unknown): z.ZodRawShape | undefined {
    if (!isRecord(schema)) {
        return undefined;
    }

    const normalizedSchema = schema as JsonSchema;
    const { types } = getTypeInfo(normalizedSchema.type);
    const isObjectType = types.includes('object') || (types.length === 0 && isRecord(normalizedSchema.properties));

    if (!isObjectType) {
        return undefined;
    }

    return buildObjectShape(normalizedSchema);
}
