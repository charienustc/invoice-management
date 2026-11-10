import type { StatsFilter, InvoiceStats } from '@shared/contracts'
import { InvoiceDatabase } from '../db/database'

export class StatsService {
  constructor(private readonly db: InvoiceDatabase) {}

  get(filter: StatsFilter): InvoiceStats {
    return this.db.getStats(filter)
  }
}
