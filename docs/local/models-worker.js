// Runs the three AI models (embeddings, re-ranker, reader) on a background thread, so the
// page stays smooth while a big PDF is being indexed. backend.js sends {id, fn, args} and
// gets {id, result} or {id, error} back; download progress is forwarded as {type: "progress"}.

import * as T from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
import { createModels } from "./engine.js?v=9f5d1f881d";

T.env.allowLocalModels = false;
const models = createModels(T, { onProgress: (p) => postMessage({ type: "progress", p }) });

onmessage = async ({ data: { id, fn, args } }) => {
  try {
    postMessage({ id, result: await models[fn](...args) });
  } catch (e) {
    postMessage({ id, error: String(e?.message || e) });
  }
};
