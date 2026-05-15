import { describe, expect, it } from "vitest";
import {
  createFindDeclarationsToolDefinition,
  describeSdkToolSchema
} from "../src/commands/sdkSmoke";

describe("SDK smoke (BS4)", () => {
  it("can describe a find_declarations tool with TxHandle, NodeId, and Diagnostic[] schema shapes", () => {
    const schema = describeSdkToolSchema();

    expect(schema.name).toEqual("find_declarations");
    expect(typeof schema.description).toEqual("string");
    expect(schema.description.length).toBeLessThan(4096);
    expect(schema.input_schema.type).toEqual("object");
    expect(schema.input_schema.properties.tx).toBeDefined();
    expect(schema.input_schema.properties.relatedNodeIds).toBeDefined();
    expect(schema.input_schema.properties.afterDiagnostics).toBeDefined();
  });

  it("is accepted by the SDK's typed tool definition surface", () => {
    const definition = createFindDeclarationsToolDefinition();

    expect(definition.name).toEqual("find_declarations");
    expect(definition.inputSchema).toBeDefined();
    expect(typeof definition.handler).toEqual("function");
  });
});
