export interface SyncTexCandidate {
  readonly path: string;
  readonly line: number;
  readonly column?: number;
  readonly page?: number;
  readonly x?: number;
  readonly y?: number;
}

export interface SyncTexViewCandidate {
  readonly output: string;
  readonly page: number;
  readonly x: number;
  readonly y: number;
}

const fieldPattern = /^(Output|Input|Line|Column|Page|x|y):\s*(.*)$/u;

export function parseSyncTexOutput(output: string): SyncTexCandidate[] {
  const candidates: SyncTexCandidate[] = [];
  let current: Record<string, string> = {};
  const commit = () => {
    const path = current.Output ?? current.Input;
    const line = Number(current.Line);
    if (path && Number.isSafeInteger(line) && line >= 1) {
      const optionalInteger = (key: string) => {
        const value = Number(current[key]);
        return Number.isSafeInteger(value) ? value : undefined;
      };
      const optionalNumber = (key: string) => {
        const value = Number(current[key]);
        return Number.isFinite(value) ? value : undefined;
      };
      const parsedColumn = optionalInteger("Column");
      const column = parsedColumn !== undefined && parsedColumn >= 0 ? parsedColumn : undefined;
      const page = optionalInteger("Page");
      const x = optionalNumber("x");
      const y = optionalNumber("y");
      candidates.push({
        path,
        line,
        ...(column === undefined ? {} : { column }),
        ...(page === undefined ? {} : { page }),
        ...(x === undefined ? {} : { x }),
        ...(y === undefined ? {} : { y }),
      });
    }
    current = {};
  };
  for (const line of output.split(/\r?\n/u)) {
    const match = fieldPattern.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if ((key === "Output" || key === "Input") && (current.Output !== undefined || current.Input !== undefined)) commit();
    current[key!] = value!.trim();
  }
  commit();
  return candidates;
}

const viewFieldPattern = /^(Output|Page|x|y|h|v):\s*(.*)$/u;

/** Parses only the small forward-navigation surface emitted by `synctex view`.
 * Unknown fields and prose are ignored; incomplete or non-finite records are
 * never promoted into navigation targets. */
export function parseSyncTexViewOutput(output: string): SyncTexViewCandidate[] {
  const candidates: SyncTexViewCandidate[] = [];
  let current: Record<string, string> = {};
  const commit = () => {
    const outputPath = current.Output;
    const page = Number(current.Page);
    const x = Number(current.x ?? current.h);
    const y = Number(current.y ?? current.v);
    if (
      outputPath !== undefined && outputPath.length > 0 && !outputPath.includes("\0") &&
      Number.isSafeInteger(page) && page >= 1 && Number.isFinite(x) && Number.isFinite(y)
    ) candidates.push({ output: outputPath, page, x, y });
    current = {};
  };
  for (const line of output.split(/\r?\n/u)) {
    const match = viewFieldPattern.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (key === "Output" && current.Output !== undefined) commit();
    current[key!] = value!.trim();
  }
  commit();
  return candidates;
}
