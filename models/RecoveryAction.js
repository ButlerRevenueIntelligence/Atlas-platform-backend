import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  orgId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  dealId: {
    type: String,
    required: true,
    maxlength: 100
  },
  dealName: {
    type: String,
    required: true
  },
  title: {
    type: String,
    required: true,
    maxlength: 500
  },
  assigneeId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User'
  },
  ownerName: {
    type: String,
    required: true
  },
  dueAt: {
    type: Date,
    required: true
  },
  status: {
    type: String,
    enum: ['open', 'in_progress', 'blocked', 'completed'],
    default: 'open'
  },
  outcome: {
    type: String,
    default: '',
    maxlength: 2000
  },
  completedAt: {
    type: Date,
    default: null
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  evidence: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  history: [{
    status: String,
    outcome: String,
    userId: mongoose.Schema.Types.ObjectId,
    at: Date
  }]
}, {
  timestamps: true,
  collection: 'recovery_actions'
});
schema.index({
  orgId: 1,
  createdAt: -1
});
export default mongoose.models.RecoveryAction || mongoose.model('RecoveryAction', schema);
