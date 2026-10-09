import OpenAI from "openai";
import { assertOpenAIKey, config } from "./config.js";

let client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  assertOpenAIKey();
  if (!client) {
    client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }
  return client;
}
