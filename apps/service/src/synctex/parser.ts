export interface SyncTexCandidate {
  readonly path: string;
  readonly line: number;
  readonly column?: number;
  readonly page?: number;
  readonly x?: number;
  readonly y?: number;
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
      const column = optionalInteger("Column");
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
