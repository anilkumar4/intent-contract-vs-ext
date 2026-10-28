import { z } from "zod/v3";

export const contractSchema = z.object({
  name: z.string().trim().min(1),
  intent: z.string().trim().min(1),
  scope: z.object({
    modify: z.array(z.string().min(1)).min(1),
    read_only: z.array(z.string().min(1)).default([]),
    modify_symbols: z.array(z.string().trim().min(1)).default([])
  }).strict(),
  architecture: z.object({
    diagram: z.string().trim().min(1),
    node_mappings: z.record(z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)),
    default_policy: z.literal("deny_unlisted_edges")
  }).strict().optional(),
  high_risk: z.object({
    include: z.array(z.string().trim().min(1)).default([]),
    exclude: z.array(z.string().trim().min(1)).default([])
  }).strict().optional(),
  forbid: z.array(z.enum(["new_dependencies", "test_weakening", "high_risk_files", "architecture_drift"])).default([]),
  allow_exceptions: z.boolean().default(false)
}).strict().superRefine((contract, context) => {
  if (contract.forbid.includes("architecture_drift") && !contract.architecture) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["architecture"],
      message: "architecture is required when forbid includes architecture_drift"
    });
  }
});

export type Contract = z.infer<typeof contractSchema>;
