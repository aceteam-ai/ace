import { EXPLAIN_DEMO } from "./explain.js";
import { SUMMARIZE_DEMO } from "./summarize.js";

export interface DemoOutput {
  input: string;
  output: string;
}

export const DEMOS: Record<string, DemoOutput> = {
  explain: EXPLAIN_DEMO,
  summarize: SUMMARIZE_DEMO,
};
