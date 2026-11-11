export interface WindowEvidenceExport {
  readonly schema_version: 1;
  readonly total_bytes: number;
  readonly files: readonly { readonly name: string; readonly bytes: number; readonly sha256: string }[];
}
export function exportWindowEvidence(options: {
  readonly evidenceRoot: string;
  readonly exportRoot: string;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
}): WindowEvidenceExport;
