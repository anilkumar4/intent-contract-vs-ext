import { z } from "zod";

export const contractSchema = z.object({
  name: z.string().trim().min(1),
  intent: z.string().trim().min(1),
  scope: z.object({
    modify: z.array(z.string().min(1)).min(1),
    read_only: z.array(z.string().min(1)).default([])
  }).strict(),
  forbid: z.array(z.enum(["new_dependencies", "test_weakening", "high_risk_files"])).default([]),
  allow_exceptions: z.boolean().default(false)
}).strict();

export type Contract = z.infer<typeof contractSchema>;
