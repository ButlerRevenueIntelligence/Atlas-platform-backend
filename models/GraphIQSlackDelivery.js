import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  orgId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  destination: {
    type: String,
    required: true
  },
  fingerprint: {
    type: String,
    required: true
  },
  claim: {
    type: String,
    required: true
  },
  state: {
    type: String,
    enum: ['sending', 'sent', 'failed', 'uncertain'],
    required: true
  },
  retryAt: Date,
  sentAt: Date,
  expiresAt: {
    type: Date,
    required: true,
    index: {
      expires: 0
    }
  }
}, {
  timestamps: true,
  collection: 'graphiq_slack_deliveries'
});
schema.index({
  orgId: 1,
  destination: 1,
  fingerprint: 1
}, {
  unique: true
});
export default mongoose.models.GraphIQSlackDelivery || mongoose.model('GraphIQSlackDelivery', schema);
