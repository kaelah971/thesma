import { usdcToMicro } from "../domain/money";

/**
 * Provider-agnostic campaign intent interpreter boundary.
 *
 * A future LLM-backed Demand Agent plugs in here by implementing
 * `CampaignIntentInterpreter` — domain and service code must never import a
 * model SDK directly. S1 ships only the deterministic local implementation,
 * which is enough for tests and the canonical demo sentence. The existence
 * of this parser does NOT mean the conversational Demand Agent is shipped.
 */

export interface InterpretedFields {
  targetOutcomeCount?: number;
  budgetMicroUsdc?: string;
  bountyFloorMicroUsdc?: string;
  bountyCeilingMicroUsdc?: string;
  minQualifyingPurchaseMicroUsdc?: string;
  /** ISO-8601 datetime string. Relative dates are never guessed. */
  deadline?: string;
}

export interface Interpretation {
  fields: InterpretedFields;
  /** Required policy fields the text did not supply. */
  missing: string[];
  notes: string[];
}

export interface CampaignIntentInterpreter {
  interpret(input: { text: string }): Promise<Interpretation>;
}

const AMOUNT = String.raw`(\d+(?:\.\d{1,6})?)`;
const USDC = String.raw`\s*usdc\b`;

function exactMicro(raw: string): string | null {
  try {
    return usdcToMicro(raw).toString();
  } catch {
    return null; // surplus precision / malformed: leave field missing, never guess
  }
}

/**
 * Deterministic heuristic parser for S1. Handles explicit USDC amounts and
 * counts; requires an explicit ISO date for deadlines and never invents
 * prices from vibes.
 */
export class LocalIntentInterpreter implements CampaignIntentInterpreter {
  async interpret(input: { text: string }): Promise<Interpretation> {
    const text = input.text;
    const fields: InterpretedFields = {};
    const notes: string[] = [];

    const target = /(?:get|bring|acquire|find|drive|close)\s+(\d+)\s+(?:new\s+)?(?:paying\s+)?(?:customers?|members?|users?|buyers?|orders?|sales|outcomes?)/i.exec(text);
    if (target) fields.targetOutcomeCount = Number.parseInt(target[1], 10);

    const budget = new RegExp(`budget\\s*(?:of\\s*|is\\s*:?\\s*)?${AMOUNT}${USDC}`, "i").exec(text);
    if (budget) {
      const micro = exactMicro(budget[1]);
      if (micro !== null) fields.budgetMicroUsdc = micro;
      else notes.push("Budget amount has more than 6 decimals and was ignored; provide an exact USDC value.");
    }

    const ceiling = new RegExp(`(?:max(?:imum)?|ceiling|up\\s+to)\\s*${AMOUNT}${USDC}(?:\\s*per\\s+(?:customer|outcome|order|sale))?`, "i").exec(text);
    if (ceiling) {
      const micro = exactMicro(ceiling[1]);
      if (micro !== null) fields.bountyCeilingMicroUsdc = micro;
      else notes.push("Maximum amount has more than 6 decimals and was ignored.");
    }

    const floor = new RegExp(`(?:floor|min(?:imum)?\\s+bounty)\\s*(?:of\\s*|is\\s*:?\\s*)?${AMOUNT}${USDC}`, "i").exec(text);
    if (floor) {
      const micro = exactMicro(floor[1]);
      if (micro !== null) fields.bountyFloorMicroUsdc = micro;
      else notes.push("Floor amount has more than 6 decimals and was ignored.");
    }

    const minPurchase =
      new RegExp(`purchases?\\s+(?:below|under)\\s*${AMOUNT}${USDC}\\s*should\\s*not\\s*count`, "i").exec(text) ??
      new RegExp(`(?:only\\s+)?purchases?\\s+(?:of\\s+)?at\\s+least\\s*${AMOUNT}${USDC}`, "i").exec(text) ??
      new RegExp(`min(?:imum)?\\s+(?:qualifying\\s+)?purchase(?:\\s+amount)?\\s*(?:of\\s*|is\\s*:?\\s*)?${AMOUNT}${USDC}`, "i").exec(text);
    if (minPurchase) {
      const micro = exactMicro(minPurchase[1]);
      if (micro !== null) fields.minQualifyingPurchaseMicroUsdc = micro;
      else notes.push("Minimum purchase amount has more than 6 decimals and was ignored.");
    }

    const iso = /(\d{4}-\d{2}-\d{2})/.exec(text);
    if (iso) {
      const parsed = new Date(`${iso[1]}T23:59:59.999Z`);
      if (!Number.isNaN(parsed.getTime())) {
        fields.deadline = parsed.toISOString();
        notes.push(`Deadline resolved to end of day UTC: ${parsed.toISOString()}.`);
      }
    } else if (/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|tomorrow|next week|weekend)\b/i.test(text)) {
      notes.push("Relative date detected; S1 never guesses dates — provide an explicit deadline (YYYY-MM-DD).");
    }

    const missing = [
      ["targetOutcomeCount", fields.targetOutcomeCount],
      ["budgetMicroUsdc", fields.budgetMicroUsdc],
      ["bountyFloorMicroUsdc", fields.bountyFloorMicroUsdc],
      ["bountyCeilingMicroUsdc", fields.bountyCeilingMicroUsdc],
      ["minQualifyingPurchaseMicroUsdc", fields.minQualifyingPurchaseMicroUsdc],
      ["deadline", fields.deadline],
    ]
      .filter(([, v]) => v === undefined)
      .map(([k]) => k as string);

    if (!("marketVisibility" in fields)) {
      notes.push("Market visibility defaults to PUBLIC; revise the draft to make it PRIVATE.");
    }
    return { fields, missing, notes };
  }
}
