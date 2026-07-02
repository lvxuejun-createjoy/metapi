import { reviewProxyText } from './review.js';
import type { ProxySafetyConfig, ProxySafetyVerdict } from './types.js';

export function createProxySafetyStreamReviewer(input: {
  config: ProxySafetyConfig;
  windowChars: number;
}) {
  const windowChars = Math.max(1, Math.trunc(input.windowChars));
  let bufferedText = '';

  return {
    reviewChunk(chunkText: string): ProxySafetyVerdict {
      bufferedText = `${bufferedText}${chunkText}`;
      if (bufferedText.length > windowChars) {
        bufferedText = bufferedText.slice(bufferedText.length - windowChars);
      }
      return reviewProxyText('response', bufferedText, input.config);
    },
    getBufferedText(): string {
      return bufferedText;
    },
  };
}
