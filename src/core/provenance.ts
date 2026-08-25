export interface EvidenceRecord {
  kind: string;
  detail?: string;
  confidence?: number;
}

export interface PassActionRecord {
  passId: string;
  action: string;
  range?: { start: number; end: number };
  confidence: number;
  evidence: string[];
  validation: "not-run" | "passed" | "failed";
  rolledBack: boolean;
}
