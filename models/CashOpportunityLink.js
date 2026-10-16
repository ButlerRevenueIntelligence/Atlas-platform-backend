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
    enum: ['live', 'test', 'demo'],
    required: true
  },
  invoiceId: {
    type: String,
    required: true
  },
  dealId: {
    type: String,
    default: null
  },
  state: {
    type: String,
    enum: ['confirmed', 'blocked'],
    required: true
  },
  note: {
    type: String,
    required: true,
    maxlength: 2000
  },
  invoiceFingerprint: {
    type: String,
    required: true
  },
  generation: {
    type: String,
    required: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  authorName: {
    type: String,
    required: true
  },
  history: [{
    state: String,
    dealId: String,
    note: String,
    at: Date,
    userId: mongoose.Schema.Types.ObjectId
  }]
}, {
  timestamps: true,
  collection: 'cash_opportunity_links'
});
schema.index({
  orgId: 1,
  provider: 1,
  accountId: 1,
  environment: 1,
  invoiceId: 1
}, {
  unique: true
});
export default mongoose.models.CashOpportunityLink || mongoose.model('CashOpportunityLink', schema);
