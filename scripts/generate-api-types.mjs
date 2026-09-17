import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = process.argv[2] ?? "contract/api/openbalance.openapi.yaml";
const output = process.argv[3] ?? "packages/sdk/src/generated/api.ts";

const document = parse(await readFile(resolve(root, source), "utf8"));
if (!document || typeof document !== "object" || !document.paths)
  throw new Error("OpenAPI document must define paths");

const name = (reference) => reference.split("/").at(-1);

/** Resolves a schema fragment to a TypeScript type expression. */
function typeOf(schema, indent) {
  if (!schema || typeof schema !== "object") return "unknown";
  if (typeof schema.$ref === "string") return name(schema.$ref);
  if (Array.isArray(schema.type)) return schema.type.map((entry) => primitive(entry)).join(" | ");
  if (Array.isArray(schema.enum))
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.type === "array") return `Array<${typeOf(schema.items, indent)}>`;
  if (schema.type === "object" || schema.properties) {
    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const lines = Object.entries(properties).map(
      ([key, value]) =>
        `${indent}  ${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${typeOf(value, `${indent}  `)};`,
    );
    if (lines.length === 0)
      return schema.additionalProperties === false
        ? "Record<string, never>"
        : "Record<string, unknown>";
    return `{\n${lines.join("\n")}\n${indent}}`;
  }
  return primitive(schema.type);
}

function primitive(type) {
  switch (type) {
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "string":
      return "string";
    default:
      return "unknown";
  }
}

const schemas = document.components?.schemas ?? {};
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const schemaEntries = Object.entries(schemas);
const declaredSchemas = schemaEntries
  .filter(([key]) => identifier.test(key))
  .map(([key, value]) => `export type ${key} = ${typeOf(value, "")};`);
const schemaLines = schemaEntries.map(([key, value]) =>
  identifier.test(key)
    ? `  ${JSON.stringify(key)}: ${key};`
    : `  ${JSON.stringify(key)}: ${typeOf(value, "  ")};`,
);

function operationType(path, method, operation) {
  const parameters = (operation.parameters ?? []).map((parameter) => {
    const target = parameter.$ref
      ? (document.components?.parameters?.[name(parameter.$ref)] ?? {})
      : parameter;
    return { target, location: target.in ?? "query" };
  });
  const parameterEntries = parameters.map(
    ({ target, location }) =>
      `        ${JSON.stringify(`${location}:${target.name}`)}${target.required ? "" : "?"}: ${typeOf(target.schema, "        ")};`,
  );
  const requestSchema =
    operation.requestBody?.content?.["application/json"]?.schema ??
    operation.requestBody?.content?.["*/*"]?.schema;
  const responses = Object.entries(operation.responses ?? {}).map(([status, response]) => {
    const target = response.$ref
      ? (document.components?.responses?.[name(response.$ref)] ?? {})
      : response;
    const schema = target.content?.["application/json"]?.schema ??
      target.content?.["*/*"]?.schema ?? { type: "object", additionalProperties: true };
    return `      ${JSON.stringify(status)}: ${typeOf(schema, "      ")};`;
  });
  return [
    "    {",
    `      method: ${JSON.stringify(method.toUpperCase())};`,
    `      path: ${JSON.stringify(path)};`,
    `      parameters: {\n${parameterEntries.join("\n")}\n      };`,
    requestSchema
      ? `      requestBody: ${typeOf(requestSchema, "      ")};`
      : "      requestBody: never;",
    `      responses: {\n${responses.join("\n")}\n      };`,
    "    }",
  ].join("\n");
}

const operationLines = [];
const pathLines = [];
for (const [path, methods] of Object.entries(document.paths)) {
  const methodEntries = [];
  for (const [method, operation] of Object.entries(methods)) {
    if (!operation || typeof operation !== "object" || !operation.operationId) continue;
    const type = operationType(path, method, operation);
    operationLines.push(`  ${JSON.stringify(operation.operationId)}: ${type};`);
    methodEntries.push(`    ${JSON.stringify(method)}: ${type};`);
  }
  pathLines.push(`  ${JSON.stringify(path)}: {\n${methodEntries.join("\n")}\n  };`);
}

const banner = `// Generated from ${source} by scripts/generate-api-types.mjs. Do not edit by hand.\n`;
await writeFile(
  resolve(root, output),
  `${banner}${declaredSchemas.join("\n")}\n\nexport type Schemas = {\n${schemaLines.join("\n")}\n};\n\nexport type Operations = {\n${operationLines.join("\n")}\n};\n\nexport type Paths = {\n${pathLines.join("\n")}\n};\n`,
  "utf8",
);
process.stdout.write(
  `${JSON.stringify({ output, schemas: schemaLines.length, operations: operationLines.length })}\n`,
);
