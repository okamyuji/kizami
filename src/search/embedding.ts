import type { EngramConfig } from '@/config';

// v0.2.0: Hugging Face Hub への暗黙的なテレメトリ/ping を遮断する。
// 初回モデルダウンロード後はオフラインのみで動作させるのが kizami のローカル完結ポリシー。
// ユーザーが明示的に `HF_HUB_OFFLINE=0` を指定していれば尊重する。
// pipeline() の import より前に必ずセットする必要がある。
export function ensureOfflineByDefault(): void {
  if (process.env['HF_HUB_OFFLINE'] === undefined) {
    process.env['HF_HUB_OFFLINE'] = '1';
  }
  if (process.env['TRANSFORMERS_OFFLINE'] === undefined) {
    process.env['TRANSFORMERS_OFFLINE'] = '1';
  }
}

let pipelineInstance: unknown = null;
let loadingPromise: Promise<unknown> | null = null;

export async function getEmbedding(text: string, config: EngramConfig): Promise<Float32Array> {
  const model = config.embedding?.model ?? 'sirasagi62/ruri-v3-30m-ONNX';
  const quantized = config.embedding?.quantized ?? true;

  if (!pipelineInstance) {
    if (!loadingPromise) {
      loadingPromise = (async () => {
        // pipeline import より前にオフライン環境変数をセットする。
        // ライブラリ初期化時に HF Hub へ ping が飛ぶのを防ぐ。
        ensureOfflineByDefault();
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
