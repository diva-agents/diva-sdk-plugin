# tool (function)

Define a typed tool. TypeScript infers the `execute` argument type from the
zod `inputSchema`, so the tool body is fully type-safe with zero casts.

```ts
const checkOrder = tool({
  name: "check_order",
  description: "Order status from the ERP",
  inputSchema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => erp.lookup(orderId),
});
```

```ts
tool<TSchema extends z.ZodType>(def: ToolInput<TSchema>): ToolDefinition<TSchema>
```

