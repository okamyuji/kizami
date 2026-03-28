import type { EngramConfig } from '../config';

let pipelineInstance: unknown = null;
let loadingPromise: Promise<unknown> | null = null;

export async function getEmbedding(text: string, config: EngramConfig): Promise<Float32Array> {
  const model = config.embedding?.model ?? 'sirasagi62/ruri-v3-30m-ONNX';
  const quantized = config.embedding?.quantized ?? true;

  if (!pipelineInstance) {
    if (!loadingPromise) {
      loadingPromise = (async () => {
        const { pipeline } = await import('@huggingface/transformers');
        const modelOptions: Record<string, unknown> = {};
        if (quantized) {
          modelOptions['dtype'] = 'q8';
        }
        pipelineInstance = await pipeline('feature-extraction', model, modelOptions);
        return pipelineInstance;
      })();
    }
    await loadingPromise;
  }

  const pipe = pipelineInstance as (
    text: string,
    options: { pooling: string; normalize: boolean }
  ) => Promise<{ data: Float32Array }>;
  const result = await pipe(text, { pooling: 'mean', normalize: true });
  return result.data;
}

export async function getEmbeddings(
  texts: string[],
  config: EngramConfig
): Promise<Float32Array[]> {
  const results: Float32Array[] = [];
  for (const text of texts) {
    results.push(await getEmbedding(text, config));
  }
  return results;
}
