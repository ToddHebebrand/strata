import { readFile } from "node:fs/promises";
import { basename } from "node:path";

interface LoadOptions {
  encoding?: BufferEncoding;
  uppercase?: boolean;
}

type LoadResult = {
  name: string;
  bytes: number;
  text: string;
};

class TextLoader {
  constructor(private readonly root: string) {}

  async load(fileName: string, options: LoadOptions = {}): Promise<LoadResult> {
    const filePath = `${this.root}/${fileName}`;
    const encoding = options.encoding ?? "utf8";
    const text = await readFile(filePath, { encoding });
    const normalized = options.uppercase ? text.toUpperCase() : text;

    return {
      name: basename(filePath),
      bytes: Buffer.byteLength(normalized, encoding),
      text: normalized
    };
  }

  describe(result: LoadResult): string {
    return `${result.name}: ${result.bytes} bytes`;
  }
}

export async function summarizeFile(root: string, fileName: string): Promise<string> {
  const loader = new TextLoader(root);
  const result = await loader.load(fileName);
  return loader.describe(result);
}
