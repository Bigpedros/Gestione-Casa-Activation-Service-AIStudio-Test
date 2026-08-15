export interface AuditRecord {
  id: string;
  timestamp: string;
  eventType: string;
  licenseCodeMasked?: string;
  licenseId?: string;
  deviceId?: string;
  requestId?: string;
  success: boolean;
  statusCode: number;
  details?: Record<string, unknown>;
}

export interface AuditRepository {
  append(record: Omit<AuditRecord, 'id' | 'timestamp'>): Promise<AuditRecord>;
  findByCorrelationId(requestId: string): Promise<AuditRecord[]>;
}
