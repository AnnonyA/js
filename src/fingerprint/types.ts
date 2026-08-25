export interface FingerprintEvidence {
  id: string;
  weight: number;
  matched: boolean;
  detail: string;
}

export interface FingerprintResult {
  jsConfuserConfidence: number;
  family: string | null;
  versionCandidates: Record<string, number>;
  evidence: FingerprintEvidence[];
}
