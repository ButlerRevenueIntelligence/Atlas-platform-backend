import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  orgId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  provider: {
    type: String,
    enum: ['quickbooks', 'stripe'],
    required: true
  },
  accountId: {
    type: String,
    required: true
  },
  environment: {
    type: String,
    enum: ['live', 'test'],
    required: true
  },
  generation: {
    type: String,
    required: true
  },
  capturedAt: {
    type: Date,
    required: true
  },
  invoices: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },
  payments: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },
  refunds: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },
  warnings: {
    type: [String],
    default: []
  }
}, {
  timestamps: true,
  collection: 'cash_evidence_snapshots'
});
schema.index({
  orgId: 1,
  provider: 1,
  accountId: 1,
  environment: 1
}, {
  unique: true
});
export default mongoose.models.CashEvidenceSnapshot || mongoose.model('CashEvidenceSnapshot', schema);
